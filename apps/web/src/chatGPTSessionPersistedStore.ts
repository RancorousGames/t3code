import { create, type StoreApi, type UseBoundStore } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { ChatGPTRecoveryEvent } from "./chatGPTRecoveryDiagnostics";
import type { RecoveryQueueState } from "./components/sidebar/chatGPTRecoveryQueue";

/**
 * T3-0102 migration boundary. Legacy writers remain authoritative until each
 * slice's callers are switched. Importing into this store never deletes,
 * replaces or replays the existing session, recovery or UNKNOWN-send keys.
 * In particular, sendJournal only indexes evidence: the original per-send
 * localStorage value remains the sole source of delivery truth.
 */
export interface ChatGPTSessionPersistedData {
  readonly schemaVersion: 1;
  readonly sessions: readonly BrowserSession[];
  readonly recovery: {
    readonly queue: RecoveryQueueState | null;
    readonly history: unknown | null;
    readonly bounded: unknown | null;
    readonly diagnostics: readonly ChatGPTRecoveryEvent[];
  };
  readonly timeline: Readonly<
    Record<
      string,
      { readonly active?: number; readonly refresh?: number; readonly reboot?: number }
    >
  >;
  readonly sendJournal: {
    readonly unknownKeys: readonly string[];
    readonly confirmedKeys: readonly string[];
    readonly archivedKeys: readonly string[];
  };
  readonly snapshots: Readonly<Record<string, unknown>>;
}

export type ChatGPTSessionPersistedStore = UseBoundStore<StoreApi<ChatGPTSessionPersistedData>> & {
  persist: { hasHydrated: () => boolean };
};
const stores = new Map<string, ChatGPTSessionPersistedStore>();
const key = (environmentId: string) => `t3code:chatgpt-browser:session-store:v1:${environmentId}`;

/** Explicit closes win over stale renderer snapshots and legacy imports.
 * The close journal is shared across windows; a stale renderer must not bring
 * a closed UUID back merely by saving unrelated session metadata. */
export function filterClosedChatGPTSessions<T extends { readonly id: string }>(
  environmentId: string,
  sessions: readonly T[],
  storage: Pick<Storage, "getItem">,
): T[] {
  let removed: unknown;
  try {
    removed = JSON.parse(
      storage.getItem(`t3code:chatgpt-browser:removal-audit:v1:${environmentId}`) ?? "[]",
    );
  } catch {
    return [...sessions];
  }
  if (!Array.isArray(removed)) return [...sessions];
  const ids = new Set(
    removed.flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const receipt = value as { sessionId?: unknown; version?: unknown };
      return receipt.version === 1 && typeof receipt.sessionId === "string"
        ? [receipt.sessionId]
        : [];
    }),
  );
  return sessions.filter((session) => !ids.has(session.id));
}

const sendPrefixes = {
  unknownKeys: "t3code:chatgpt-unknown-send-fence:v1:",
  confirmedKeys: "t3code:chatgpt-confirmed-delivery:v1:",
  archivedKeys: "t3code:chatgpt-legacy-unknown-archive:v1:",
} as const;

function readJSON(storage: Storage, name: string): unknown {
  const raw = storage.getItem(name);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Keep corrupt legacy bytes untouched so they remain recoverable.
    return null;
  }
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Read-only and repeatable: a migration failure must never erase a legacy key. */
export function readLegacyChatGPTSessionData(
  environmentId: string,
  local: Storage,
  session: Storage,
): ChatGPTSessionPersistedData {
  const rawSessions = readJSON(local, `t3code:chatgpt-browser:sessions:${environmentId}`);
  const sessions: BrowserSession[] = Array.isArray(rawSessions)
    ? filterClosedChatGPTSessions(
        environmentId,
        rawSessions.filter(
          (entry): entry is BrowserSession =>
            entry !== null &&
            typeof entry === "object" &&
            typeof entry.id === "string" &&
            typeof entry.title === "string",
        ),
        local,
      )
    : [];

  const timeline: Record<string, { active?: number; refresh?: number; reboot?: number }> = {};
  const sendJournal: {
    unknownKeys: string[];
    confirmedKeys: string[];
    archivedKeys: string[];
  } = { unknownKeys: [], confirmedKeys: [], archivedKeys: [] };
  const timelinePrefix = "t3code:chatgpt-browser:last-";
  const legacyEnvironmentSuffix = `:${environmentId}:`;

  // Enumerate keys rather than assuming every old timeline entry belongs to a
  // currently visible session. Hidden/closed records must survive migration too.
  for (let i = 0; i < local.length; i++) {
    const itemKey = local.key(i);
    if (itemKey === null) continue;
    for (const [kind, prefix] of Object.entries(sendPrefixes)) {
      if (itemKey.startsWith(prefix + environmentId + ":")) {
        sendJournal[kind as keyof typeof sendJournal].push(itemKey);
      }
    }
    if (!itemKey.startsWith(timelinePrefix)) continue;
    for (const kind of ["active", "refresh", "reboot"] as const) {
      const prefix = timelinePrefix + kind + legacyEnvironmentSuffix;
      if (!itemKey.startsWith(prefix)) continue;
      const id = itemKey.slice(prefix.length);
      const observed = readJSON(local, itemKey);
      if (!id || !validTime(observed)) continue;
      timeline[id] = { ...timeline[id], [kind]: observed };
    }
  }

  const rawQueue = readJSON(session, `t3code:chatgpt-browser:recovery-queue:${environmentId}`);
  const queue =
    rawQueue && typeof rawQueue === "object" && !Array.isArray(rawQueue)
      ? (rawQueue as RecoveryQueueState)
      : null;
  const rawDiagnostics = readJSON(local, `t3code:chatgpt-browser:recovery-log:${environmentId}`);
  const diagnostics: ChatGPTRecoveryEvent[] = Array.isArray(rawDiagnostics)
    ? rawDiagnostics.filter(
        (entry): entry is ChatGPTRecoveryEvent =>
          entry !== null &&
          typeof entry === "object" &&
          validTime(entry.at) &&
          typeof entry.sessionId === "string" &&
          typeof entry.event === "string",
      )
    : [];

  return {
    schemaVersion: 1,
    sessions,
    recovery: {
      queue,
      history: readJSON(local, `t3code:chatgpt-browser:recovery:${environmentId}`),
      bounded: readJSON(local, `t3code:chatgpt-browser:bounded-recovery:${environmentId}`),
      diagnostics,
    },
    timeline,
    sendJournal,
    snapshots: {},
  };
}

/**
 * Lazily initialize each environment. Zustand persistence owns the new key;
 * a preexisting store snapshot is hydrated instead of migrating again.
 * The original send fence keys continue to be read by the send guard.
 */
export function getChatGPTSessionPersistedStore(
  environmentId: string,
): ChatGPTSessionPersistedStore {
  const existing = stores.get(environmentId);
  if (existing) return existing;
  if (typeof window === "undefined")
    throw new Error("ChatGPT session persistence requires a browser.");
  const local = window.localStorage;
  const initial = readLegacyChatGPTSessionData(environmentId, local, window.sessionStorage);
  const store = create<ChatGPTSessionPersistedData>()(
    persist(() => initial, {
      name: key(environmentId),
      // v1 was a dual-write mirror; legacy session lists remained authoritative.
      // Upgrade once before the v2 store owns session reads, or concurrent v1
      // mirror updates can silently omit sessions created by the old UI.
      version: 2,
      migrate: (persisted) => {
        const previous = persisted as Partial<ChatGPTSessionPersistedData> | null;
        const legacy = readLegacyChatGPTSessionData(environmentId, local, window.sessionStorage);
        if (!previous) return legacy;
        const olderRecovery = previous.recovery;
        const olderTimeline = previous.timeline ?? {};
        const timeline = { ...olderTimeline };
        for (const [id, times] of Object.entries(legacy.timeline)) {
          const old = timeline[id] ?? {};
          const merged: { active?: number; refresh?: number; reboot?: number } = { ...old };
          for (const kind of ["active", "refresh", "reboot"] as const) {
            const value = Math.max(old[kind] ?? 0, times[kind] ?? 0);
            if (value > 0) merged[kind] = value;
          }
          timeline[id] = merged;
        }
        return {
          ...legacy,
          // The old list is the authoritative v1 writer, including completion,
          // hidden state, hierarchy and manual edits. Keep old store only if the
          // legacy list has already been legitimately retired.
          sessions: filterClosedChatGPTSessions(
            environmentId,
            local.getItem(`t3code:chatgpt-browser:sessions:${environmentId}`) !== null
              ? legacy.sessions
              : (previous.sessions ?? []),
            local,
          ),
          recovery: {
            queue: legacy.recovery.queue,
            history: legacy.recovery.history ?? olderRecovery?.history ?? null,
            bounded: legacy.recovery.bounded ?? olderRecovery?.bounded ?? null,
            diagnostics: legacy.recovery.diagnostics.length
              ? legacy.recovery.diagnostics
              : (olderRecovery?.diagnostics ?? []),
          },
          timeline,
          sendJournal: {
            unknownKeys: [
              ...new Set([
                ...(previous.sendJournal?.unknownKeys ?? []),
                ...legacy.sendJournal.unknownKeys,
              ]),
            ],
            confirmedKeys: [
              ...new Set([
                ...(previous.sendJournal?.confirmedKeys ?? []),
                ...legacy.sendJournal.confirmedKeys,
              ]),
            ],
            archivedKeys: [
              ...new Set([
                ...(previous.sendJournal?.archivedKeys ?? []),
                ...legacy.sendJournal.archivedKeys,
              ]),
            ],
          },
          snapshots: previous.snapshots ?? legacy.snapshots,
        };
      },
      merge: (persisted, current) => {
        const saved = persisted as ChatGPTSessionPersistedData | undefined;
        if (!saved) return current;
        return {
          ...current,
          ...saved,
          sessions: filterClosedChatGPTSessions(environmentId, saved.sessions ?? [], local),
        };
      },
      storage: createJSONStorage(() => local),
    }),
  );
  stores.set(environmentId, store);
  // A close recorded in another renderer invalidates this window's stale list.
  if (typeof window.addEventListener === "function") {
    window.addEventListener("storage", (event) => {
      if (event.key !== `t3code:chatgpt-browser:removal-audit:v1:${environmentId}`) return;
      const current = store.getState().sessions;
      // Use the other renderer's latest authoritative list, not our stale copy.
      const latest = readLegacyChatGPTSessionData(
        environmentId,
        local,
        window.sessionStorage,
      ).sessions;
      if (
        current.length !== latest.length ||
        current.some((session, i) => session.id !== latest[i]?.id)
      ) {
        store.setState({ sessions: latest });
      }
    });
  }
  return store;
}
