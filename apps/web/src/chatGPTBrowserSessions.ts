import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback } from "react";
import { useStore } from "zustand";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";

import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import {
  CANONICAL_CHATGPT_CONVERSATION_ID,
  chatGPTConversationIdFromUrl,
} from "./chatGPTConversationIdentity";
import { chatGPTPrewarmKey, isChatGPTHomeUrl, takeChatGPTSpare } from "./chatGPTBrowserPrewarm";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { randomUUID } from "./lib/utils";
import {
  finalizeChatGPTRolloverHierarchy,
  type ChatGPTRolloverPlan,
} from "./chatGPTRolloverFinalize";
import { readThreadPreviewState } from "./previewStateStore";

export const BrowserSession = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  // Present only for sessions created after timestamp tracking was introduced.
  createdAt: Schema.optional(Schema.Number),
  // Immutable creation evidence. Older entries without it remain unknown unless
  // they carry an explicit backend spawn reservation; titles/lineage are not proof.
  creationOrigin: Schema.optional(Schema.Literals(["manual", "backend"])),
  // A backend-created worker becomes a personal chat after an actual human send
  // or a user-assigned highlight. Creation provenance remains unchanged.
  humanControlled: Schema.optional(Schema.Boolean),
  // An exact backend spawn reservation. Manual sessions and warm spares never carry it.
  spawnRequestId: Schema.optional(Schema.String),
  // Only explicit UI-created fresh chats carry this; legacy and backend guests do not.
  manualEmptyCandidateCreatedAt: Schema.optional(Schema.Number),
  manualEmptyCandidateDisqualified: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  hiddenAt: Schema.optional(Schema.Number),
  archive: Schema.optional(
    Schema.Struct({
      archivedAt: Schema.String,
      conversationUrl: Schema.String,
      basis: Schema.Literals(["completion", "manager_decision"]),
      reason: Schema.optional(Schema.String),
      restoredAt: Schema.optional(Schema.String),
    }),
  ),
  snoozedUntil: Schema.optional(Schema.Number),
  // Sticky exemptions: unsnooze or clearing a colored border never reenables auto-close.
  autoCloseExempt: Schema.optional(Schema.Boolean),
  lastDirectInteractionAt: Schema.optional(Schema.Number),
  // null explicitly detaches a child; undefined means no lineage was ever recorded.
  parentSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  project: Schema.optional(Schema.String),
  // User-chosen sidebar border color name; unknown names render no border.
  borderColor: Schema.optional(Schema.String),
  completion: Schema.optional(
    Schema.Struct({
      declaredAt: Schema.String,
      observedTurns: Schema.Number,
      observedUrl: Schema.NullOr(Schema.String),
    }),
  ),
});
export type BrowserSession = typeof BrowserSession.Type;

/** Persisted origin has priority except where a backend reservation proves otherwise. */
export function chatGPTSessionCreationOrigin(
  session: BrowserSession,
): "manual" | "backend" | "unknown" {
  if (session.spawnRequestId?.trim()) return "backend";
  return session.creationOrigin ?? "unknown";
}

const BrowserSessions = Schema.Array(BrowserSession);
export const chatGPTBrowserSessionsKey = (environmentId: EnvironmentId | null) =>
  `t3code:chatgpt-browser:sessions:${environmentId ?? "unconnected"}`;

/** Read the authoritative persisted snapshot during consecutive desktop requests. */
export function readChatGPTBrowserSessions(
  environmentId: EnvironmentId,
): readonly BrowserSession[] {
  if (typeof window === "undefined") return INITIAL_SESSIONS;
  const sessions = getChatGPTSessionPersistedStore(environmentId).getState().sessions;
  return sessions.length ? sessions : INITIAL_SESSIONS;
}
const INITIAL_SESSIONS: readonly BrowserSession[] = [{ id: "chatgpt", title: "ChatGPT 1" }];
const DEFAULT_SESSION_TITLE = /^ChatGPT \d+$/;

export function chatGPTSessionTitleFromPage(pageTitle: string | null): string | null {
  const title = (pageTitle ?? "")
    .trim()
    .replace(/\s+[-–—|]\s+(?:ChatGPT|OpenAI)$/i, "")
    .replace(/^ChatGPT\s+[-–—|]\s+/i, "")
    .trim();
  if (!title || /^(?:ChatGPT(?: \d+)?|New chat|Temporary chat|OpenAI)$/i.test(title)) {
    return null;
  }
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
}

export const CHATGPT_DEFAULT_URL = "https://chatgpt.com";

/** Resolve exact persisted conversation ownership; never infer it from titles or T3 session IDs. */
export function findExistingChatGPTConversation(
  sessions: readonly BrowserSession[],
  targetUrl: string,
  readUrl: (sessionId: string) => string | null,
): BrowserSession | undefined {
  const id = chatGPTConversationIdFromUrl(targetUrl);
  if (!id || !CANONICAL_CHATGPT_CONVERSATION_ID.test(id)) return undefined;
  return sessions.find(
    (session) =>
      chatGPTConversationIdFromUrl(
        readUrl(session.id) ?? session.archive?.conversationUrl ?? null,
      ) === id,
  );
}

export function isChatGPTConversationUrl(url: string | null): boolean {
  return chatGPTConversationIdFromUrl(url) !== null;
}

export const chatGPTBrowserLastUrlKey = (environmentId: EnvironmentId, sessionId: string) =>
  sessionId === "chatgpt"
    ? `t3code:chatgpt-browser:last-url:${environmentId}`
    : `t3code:chatgpt-browser:last-url:${environmentId}:${sessionId}`;

export const chatGPTBrowserLastWorkingKey = (environmentId: EnvironmentId, sessionId: string) =>
  `t3code:chatgpt-browser:last-working:${environmentId}:${sessionId}`;

export const chatGPTBrowserRemovalAuditKey = (environmentId: EnvironmentId) =>
  `t3code:chatgpt-browser:removal-audit:v1:${environmentId}`;

export type ChatGPTSessionRemovalSource =
  | "sidebar-user-action"
  | "desktop-menu-action"
  | "desktop-IPC-request"
  | "expiration"
  | "unused-empty-manual"
  | "completed-worker"
  | "unknown";

export type ChatGPTSessionRemovalReceipt = {
  readonly version: 1;
  readonly sessionId: string;
  readonly removedAt: string;
  readonly title: string;
  readonly parentSessionId: string | null | "UNKNOWN";
  readonly conversationId: string | null;
  readonly source: ChatGPTSessionRemovalSource;
  // A UI click or desktop IPC request is not proof of the actual human caller.
  readonly authenticatedCaller: "UNKNOWN";
  readonly draftSafetyVerified: false;
  readonly completionVerified: false;
  readonly persistence: "local-session-list-verified";
};

const MAX_REMOVAL_RECEIPTS = 128;

/** Merge idempotently by the removed local UUID. Oldest entries rotate at the cap. */
export function mergeChatGPTSessionRemovalReceipts(
  current: readonly ChatGPTSessionRemovalReceipt[],
  receipt: ChatGPTSessionRemovalReceipt,
): ChatGPTSessionRemovalReceipt[] {
  if (current.some((entry) => entry.sessionId === receipt.sessionId)) return [...current];
  return [...current, receipt].slice(-MAX_REMOVAL_RECEIPTS);
}

/**
 * Evidence is limited to a verified change in T3's locally persisted session
 * index. It does not prove guest deletion, safe drafts, completion, or a user's
 * identity. Never load or navigate a guest to infer its conversation identity.
 */
function recordPersistedChatGPTSessionRemoval(
  environmentId: EnvironmentId | null,
  entry: BrowserSession | undefined,
  source: ChatGPTSessionRemovalSource,
): void {
  if (!environmentId || !entry) return;
  try {
    if (readChatGPTBrowserSessions(environmentId).some((saved) => saved.id === entry.id)) return;
    const key = chatGPTBrowserRemovalAuditKey(environmentId);
    const storage = window.localStorage;
    const raw = storage.getItem(key);
    const decoded: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(decoded)) throw new Error("Invalid removal journal.");
    // Never replace corrupt historical evidence or accidentally copy other data.
    if (decoded.some((value) => !isChatGPTSessionRemovalReceipt(value)))
      throw new Error("Invalid removal journal receipt.");
    const existing = decoded as ChatGPTSessionRemovalReceipt[];
    if (existing.some((value) => value.sessionId === entry.id)) return;
    let cachedUrl: string | null = null;
    try {
      cachedUrl = getLocalStorageItem(
        chatGPTBrowserLastUrlKey(environmentId, entry.id),
        Schema.String,
      );
    } catch {
      // A missing/invalid cached URL is not evidence of a particular conversation.
    }
    const receipt: ChatGPTSessionRemovalReceipt = {
      version: 1,
      sessionId: entry.id,
      removedAt: new Date().toISOString(),
      title: entry.title,
      parentSessionId: entry.parentSessionId === undefined ? "UNKNOWN" : entry.parentSessionId,
      conversationId: chatGPTConversationIdFromUrl(
        cachedUrl ?? entry.archive?.conversationUrl ?? null,
      ),
      source,
      authenticatedCaller: "UNKNOWN",
      draftSafetyVerified: false,
      completionVerified: false,
      persistence: "local-session-list-verified",
    };
    const updated = JSON.stringify(mergeChatGPTSessionRemovalReceipts(existing, receipt));
    storage.setItem(key, updated);
    if (storage.getItem(key) !== updated) throw new Error("Removal journal write did not persist.");
  } catch {
    // Audit is best-effort, never a reason to change an existing close/save flow.
    console.warn("[ChatGPT removal audit] Could not persist local removal provenance.");
  }
}

function isChatGPTSessionRemovalReceipt(value: unknown): value is ChatGPTSessionRemovalReceipt {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ChatGPTSessionRemovalReceipt>;
  // Never round-trip unknown fields from a corrupted or externally modified
  // journal: an extra field could otherwise smuggle message or draft content.
  if (
    Object.keys(value).sort().join(",") !==
    "authenticatedCaller,completionVerified,conversationId,draftSafetyVerified,parentSessionId,persistence,removedAt,sessionId,source,title,version"
  )
    return false;
  return (
    entry.version === 1 &&
    typeof entry.sessionId === "string" &&
    typeof entry.removedAt === "string" &&
    typeof entry.title === "string" &&
    (typeof entry.parentSessionId === "string" || entry.parentSessionId === null) &&
    (typeof entry.conversationId === "string" || entry.conversationId === null) &&
    (entry.source === "sidebar-user-action" ||
      entry.source === "desktop-menu-action" ||
      entry.source === "desktop-IPC-request" ||
      entry.source === "expiration" ||
      entry.source === "unused-empty-manual" ||
      entry.source === "completed-worker" ||
      entry.source === "unknown") &&
    entry.authenticatedCaller === "UNKNOWN" &&
    entry.draftSafetyVerified === false &&
    entry.completionVerified === false &&
    entry.persistence === "local-session-list-verified"
  );
}

// Preview uses this owner only to group tabs; no agent conversation is created.
export const chatGPTBrowserThreadRef = (environmentId: EnvironmentId, sessionId: string) =>
  scopeThreadRef(environmentId, ThreadId.make(`t3-browser-session:${sessionId}`));

/** Move a session within its visible or hidden section without changing the other section. */
export function reorderChatGPTSessions(
  sessions: readonly BrowserSession[],
  movingId: string,
  overId: string,
): BrowserSession[] {
  const from = sessions.findIndex((session) => session.id === movingId);
  const to = sessions.findIndex((session) => session.id === overId);
  if (from === -1 || to === -1 || from === to) return [...sessions];
  const hidden = sessions[from]?.hidden === true;
  if ((sessions[to]?.hidden === true) !== hidden) return [...sessions];
  const sectionIndices = sessions.flatMap((session, index) =>
    (session.hidden === true) === hidden ? [index] : [],
  );
  const section = sectionIndices.map((index) => sessions[index]!);
  const source = section.findIndex((session) => session.id === movingId);
  const target = section.findIndex((session) => session.id === overId);
  if (source === -1 || target === -1) return [...sessions];
  const [removed] = section.splice(source, 1);
  section.splice(target, 0, removed!);
  const reordered = [...sessions];
  sectionIndices.forEach((index, position) => {
    reordered[index] = section[position]!;
  });
  return reordered;
}

/**
 * A sidebar project drag moves the linked ChatGPT subtree as one unit.
 * Keep existing session order/guest state and child links; only the dragged
 * root detaches from its old parent. A visited set bounds corrupt cycles.
 */
export function moveChatGPTSessionProject(
  sessions: readonly BrowserSession[],
  id: string,
  project: string | null,
): BrowserSession[] {
  if (!sessions.some((session) => session.id === id)) return [...sessions];

  const children = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const siblings = children.get(session.parentSessionId) ?? [];
    siblings.push(session.id);
    children.set(session.parentSessionId, siblings);
  }

  const moving = new Set([id]);
  const pending = [id];
  while (pending.length) {
    for (const childId of children.get(pending.pop()!) ?? []) {
      if (moving.has(childId)) continue;
      moving.add(childId);
      pending.push(childId);
    }
  }

  const target = project ?? "Other";
  return sessions.map((session) =>
    !moving.has(session.id)
      ? session
      : session.id === id
        ? { ...session, project: target, parentSessionId: null }
        : { ...session, project: target },
  );
}

/** Hiding prepends to the hidden list; restoring appends to the live list. */
export function setChatGPTSessionHidden(
  sessions: readonly BrowserSession[],
  id: string,
  hidden: boolean,
): BrowserSession[] {
  const target = sessions.find((session) => session.id === id);
  if (!target || (target.hidden === true) === hidden) return [...sessions];

  const remaining = sessions.filter((session) => session.id !== id);
  const visible = remaining.filter((session) => session.hidden !== true);
  const hiddenSessions = remaining.filter((session) => session.hidden === true);
  const updated = {
    ...target,
    hidden,
    hiddenAt: hidden ? Date.now() : undefined,
    ...(target.archive && !hidden
      ? { archive: { ...target.archive, restoredAt: new Date().toISOString() } }
      : {}),
  };
  return [...visible, updated, ...hiddenSessions];
}

/** An archive is a durable, restorable session record, not an expiring sidebar hide. */
export function setChatGPTSessionArchived(
  sessions: readonly BrowserSession[],
  id: string,
  archive: NonNullable<BrowserSession["archive"]>,
): BrowserSession[] {
  const entry = sessions.find((session) => session.id === id);
  if (!entry) return [...sessions];
  if (entry.hidden && entry.archive && !entry.archive.restoredAt) return [...sessions];
  const visible = sessions.filter((session) => session.id !== id && !session.hidden);
  const hidden = sessions.filter((session) => session.id !== id && session.hidden);
  return [...visible, { ...entry, hidden: true, hiddenAt: Date.now(), archive }, ...hidden];
}

export const CHATGPT_HIDDEN_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

/** Unknown legacy hide times are never treated as expired. */
export function expiredHiddenSessionIds(
  sessions: readonly BrowserSession[],
  now: number,
): string[] {
  return sessions
    .filter(
      (session) =>
        session.hidden === true &&
        // A manager archive survives indefinitely; only a plain UI hide expires.
        !(session.archive && !session.archive.restoredAt) &&
        typeof session.hiddenAt === "number" &&
        Number.isFinite(session.hiddenAt) &&
        session.hiddenAt > 0 &&
        now - session.hiddenAt >= CHATGPT_HIDDEN_EXPIRY_MS,
    )
    .map((session) => session.id);
}

export function useChatGPTBrowserSessions(environmentId: EnvironmentId | null) {
  const sessionStore = getChatGPTSessionPersistedStore(environmentId ?? "unconnected");
  const storedSessions = useStore(sessionStore, (state) => state.sessions);
  const sessions = storedSessions.length ? storedSessions : INITIAL_SESSIONS;
  const setSessions = useCallback(
    (
      update:
        | readonly BrowserSession[]
        | ((current: readonly BrowserSession[]) => readonly BrowserSession[]),
    ) => {
      const current = sessionStore.getState().sessions;
      const next =
        typeof update === "function" ? update(current.length ? current : INITIAL_SESSIONS) : update;
      setLocalStorageItem(chatGPTBrowserSessionsKey(environmentId), next, BrowserSessions);
      sessionStore.setState({ sessions: next });
    },
    [sessionStore, environmentId],
  );
  const [prewarmedSessionId, setPrewarmedSessionId] = useLocalStorage(
    chatGPTPrewarmKey(environmentId ?? "unconnected"),
    "",
    Schema.String,
  );

  const createSession = useCallback(
    (
      name?: string,
      metadata?: {
        parentSessionId?: string;
        project?: string;
        initialConversationUrl?: string;
        spawnRequestId?: string;
        explicitlyUserCreated?: boolean;
      },
    ) => {
      // Opening a known /c/ conversation reuses the original T3 identity.
      // Do not replace the guest or its composer draft, even for hidden/snoozed owners.
      if (environmentId && metadata?.initialConversationUrl && !metadata.spawnRequestId) {
        const requestedId = chatGPTConversationIdFromUrl(metadata.initialConversationUrl);
        if (
          !requestedId ||
          metadata.initialConversationUrl !== `https://chatgpt.com/c/${requestedId}`
        )
          throw new Error("Only an exact canonical ChatGPT conversation URL may seed a session.");
        const owner = findExistingChatGPTConversation(
          readChatGPTBrowserSessions(environmentId),
          metadata.initialConversationUrl,
          (id) => getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, id), Schema.String),
        );
        if (owner) {
          setSessions((current) =>
            current.map((session) =>
              session.id === owner.id
                ? {
                    ...session,
                    hidden: false,
                    hiddenAt: undefined,
                    snoozedUntil: undefined,
                    ...(session.archive
                      ? {
                          archive: { ...session.archive, restoredAt: new Date().toISOString() },
                        }
                      : {}),
                  }
                : session,
            ),
          );
          return owner.id;
        }
      }
      let id = randomUUID();
      // Read the current slot synchronously: multiple buttons, the palette and
      // desktop automation can request sessions without waiting for a render.
      // A warm spare belongs only to an explicit human UI action. Backend or
      // unspecified callers always receive a fresh UUID/guest, even without a receipt.
      if (
        environmentId &&
        metadata?.explicitlyUserCreated === true &&
        !metadata.initialConversationUrl &&
        !metadata.spawnRequestId
      ) {
        const spareId = getLocalStorageItem(chatGPTPrewarmKey(environmentId), Schema.String);
        if (spareId) {
          const threadRef = chatGPTBrowserThreadRef(environmentId, spareId);
          const state = readThreadPreviewState(threadRef);
          const tabId = state.activeTabId;
          const nav = tabId ? state.sessions[tabId]?.navStatus : null;
          const overlay = tabId ? state.desktopByTabId[tabId] : null;
          const attached =
            !!tabId &&
            !!state.serverEpoch &&
            Array.from(document.querySelectorAll("webview")).some(
              (element) =>
                element.dataset.previewTab ===
                previewRuntimeTabId(threadRef, state.serverEpoch, tabId),
            );
          if (
            !sessions.some((session) => session.id === spareId) &&
            nav?._tag === "Success" &&
            isChatGPTHomeUrl(nav.url) &&
            overlay?.hasWebContents &&
            !overlay.loading &&
            attached &&
            takeChatGPTSpare(environmentId, spareId)
          ) {
            id = spareId;
            // The consumed webview remains mounted under its original preview
            // owner; replenishment gets a different owner and a fresh page.
            setPrewarmedSessionId(randomUUID());
          }
        }
      }
      // Routing an existing /c/<id> must not reuse a prewarmed homepage: its
      // attached guest would ignore the initial URL and might receive a prompt
      // in a different conversation. Seed the new owner before it is mounted.
      if (environmentId && metadata?.initialConversationUrl) {
        const idInUrl = chatGPTConversationIdFromUrl(metadata.initialConversationUrl);
        if (!idInUrl || metadata.initialConversationUrl !== `https://chatgpt.com/c/${idInUrl}`)
          throw new Error("Only an exact canonical ChatGPT conversation URL may seed a session.");
        setLocalStorageItem(
          chatGPTBrowserLastUrlKey(environmentId, id),
          metadata.initialConversationUrl,
          Schema.String,
        );
      }
      const createdAt = Date.now();
      setSessions((current) => {
        let number = 1;
        while (current.some((session) => session.title === `ChatGPT ${number}`)) number += 1;
        return [
          ...current,
          {
            id,
            title: name?.trim() || `ChatGPT ${number}`,
            createdAt,
            ...(metadata?.spawnRequestId
              ? { creationOrigin: "backend" as const, spawnRequestId: metadata.spawnRequestId }
              : metadata?.explicitlyUserCreated && !metadata.initialConversationUrl
                ? { creationOrigin: "manual" as const }
                : {}),
            ...(metadata?.explicitlyUserCreated &&
            !name &&
            !metadata.initialConversationUrl &&
            !metadata.spawnRequestId &&
            !metadata.parentSessionId &&
            !metadata.project
              ? { manualEmptyCandidateCreatedAt: Date.now() }
              : {}),
            ...(metadata?.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
            ...(metadata?.project ? { project: metadata.project } : {}),
          },
        ];
      });
      return id;
    },
    [environmentId, sessions, setPrewarmedSessionId, setSessions],
  );

  const disqualifyManualEmptyCandidate = useCallback(
    (id: string) =>
      setSessions((current) => {
        if (
          !current.some(
            (session) =>
              session.id === id &&
              session.manualEmptyCandidateCreatedAt &&
              !session.manualEmptyCandidateDisqualified,
          )
        )
          return current;
        return current.map((session) =>
          session.id === id ? { ...session, manualEmptyCandidateDisqualified: true } : session,
        );
      }),
    [setSessions],
  );

  const setSessionCompletion = useCallback(
    (id: string, completion: BrowserSession["completion"] | undefined) => {
      setSessions((current) =>
        current.map((session) => (session.id === id ? { ...session, completion } : session)),
      );
    },
    [setSessions],
  );

  const finalizeRollover = useCallback(
    (plan: ChatGPTRolloverPlan) => {
      setSessions((current) => finalizeChatGPTRolloverHierarchy(current, plan));
    },
    [setSessions],
  );

  const setSessionParent = useCallback(
    (id: string, parentId: string | null) => {
      setSessions((current) => {
        if (parentId === id) return current;
        const byId = new Map(current.map((entry) => [entry.id, entry]));
        if (parentId && !byId.has(parentId)) return current;
        let cursor = parentId;
        const seen = new Set<string>();
        while (cursor) {
          if (cursor === id || seen.has(cursor)) return current;
          seen.add(cursor);
          cursor = byId.get(cursor)?.parentSessionId ?? null;
        }
        return current.map((session) =>
          session.id === id
            ? {
                ...session,
                parentSessionId: parentId,
                project: parentId
                  ? (byId.get(parentId)?.project ?? session.project)
                  : session.project,
              }
            : session,
        );
      });
    },
    [setSessions],
  );

  const setSessionProject = useCallback(
    (id: string, project: string | null) =>
      setSessions((current) => moveChatGPTSessionProject(current, id, project)),
    [setSessions],
  );

  const setSessionSnooze = useCallback(
    (ids: readonly string[], until: number | null) => {
      const targets = new Set(ids);
      setSessions((current) =>
        current.map((session) =>
          targets.has(session.id)
            ? {
                ...session,
                snoozedUntil: until ?? undefined,
                autoCloseExempt: session.autoCloseExempt === true || until !== null,
              }
            : session,
        ),
      );
    },
    [setSessions],
  );

  const setSessionBorderColor = useCallback(
    (id: string, color: string | null) =>
      setSessions((current) =>
        current.map((session) =>
          session.id === id
            ? {
                ...session,
                borderColor: color ?? undefined,
                humanControlled: session.humanControlled === true || color !== null,
                autoCloseExempt: session.autoCloseExempt === true || color !== null,
              }
            : session,
        ),
      ),
    [setSessions],
  );

  const markHumanControlled = useCallback(
    (id: string) =>
      setSessions((current) =>
        current.map((session) =>
          session.id === id && !session.humanControlled
            ? { ...session, humanControlled: true, autoCloseExempt: true }
            : session,
        ),
      ),
    [setSessions],
  );

  const markDirectInteraction = useCallback(
    (id: string, at = Date.now()) => {
      setSessions((current) =>
        current.map((session) =>
          session.id === id && at > (session.lastDirectInteractionAt ?? 0)
            ? { ...session, lastDirectInteractionAt: at }
            : session,
        ),
      );
    },
    [setSessions],
  );

  const syncInferredMetadata = useCallback(
    (
      updates: ReadonlyArray<{
        readonly id: string;
        readonly project?: string | undefined;
        readonly parentSessionId?: string | undefined;
      }>,
    ) => {
      const byId = new Map(updates.map((entry) => [entry.id, entry]));
      setSessions((current) => {
        let changed = false;
        const next = current.map((session) => {
          const update = byId.get(session.id);
          if (!update) return session;
          const project = session.project ?? update.project;
          const parentSessionId =
            session.parentSessionId === undefined
              ? update.parentSessionId
              : session.parentSessionId;
          if (project === session.project && parentSessionId === session.parentSessionId)
            return session;
          changed = true;
          return {
            ...session,
            ...(project ? { project } : {}),
            ...(parentSessionId ? { parentSessionId } : {}),
          };
        });
        return changed ? next : current;
      });
    },
    [setSessions],
  );

  const pruneExpiredHidden = useCallback(
    (now: number) => {
      const expired = expiredHiddenSessionIds(sessions, now);
      if (!expired.length) return [] as string[];
      const ids = new Set(expired);
      let removed: BrowserSession[] = [];
      setSessions((current) => {
        removed = current.filter((session) => ids.has(session.id));
        return current
          .filter((session) => !ids.has(session.id))
          .map((session) =>
            session.parentSessionId && ids.has(session.parentSessionId)
              ? { ...session, parentSessionId: null }
              : session,
          );
      });
      for (const entry of removed)
        recordPersistedChatGPTSessionRemoval(environmentId, entry, "expiration");
      return expired;
    },
    [environmentId, sessions, setSessions],
  );

  const renameSession = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      setSessions((current) =>
        current.map((session) => (session.id === id ? { ...session, title: trimmed } : session)),
      );
    },
    [setSessions],
  );

  const renameSessionFromPageTitle = useCallback(
    (id: string, pageTitle: string | null) => {
      const title = chatGPTSessionTitleFromPage(pageTitle);
      if (!title) return;
      setSessions((current) =>
        current.map((session) =>
          session.id === id && DEFAULT_SESSION_TITLE.test(session.title)
            ? { ...session, title }
            : session,
        ),
      );
    },
    [setSessions],
  );

  const removeSession = useCallback(
    (id: string, source: ChatGPTSessionRemovalSource = "unknown") => {
      let removed: BrowserSession | undefined;
      setSessions((current) => {
        removed = current.find((session) => session.id === id);
        return current
          .filter((session) => session.id !== id)
          .map((session) =>
            session.parentSessionId === id ? { ...session, parentSessionId: null } : session,
          );
      });
      recordPersistedChatGPTSessionRemoval(environmentId, removed, source);
    },
    [environmentId, setSessions],
  );

  const reorderSessions = useCallback(
    (movingId: string, overId: string) =>
      setSessions((current) => reorderChatGPTSessions(current, movingId, overId)),
    [setSessions],
  );

  const setSessionHidden = useCallback(
    (id: string, hidden: boolean) =>
      setSessions((current) => setChatGPTSessionHidden(current, id, hidden)),
    [setSessions],
  );

  const setSessionArchived = useCallback(
    (id: string, archive: NonNullable<BrowserSession["archive"]>) =>
      setSessions((current) => setChatGPTSessionArchived(current, id, archive)),
    [setSessions],
  );

  return {
    sessions,
    prewarmedSessionId,
    setPrewarmedSessionId,
    createSession,
    disqualifyManualEmptyCandidate,
    reorderSessions,
    renameSession,
    renameSessionFromPageTitle,
    removeSession,
    setSessionHidden,
    setSessionArchived,
    setSessionProject,
    setSessionParent,
    finalizeRollover,
    setSessionSnooze,
    setSessionBorderColor,
    markHumanControlled,
    markDirectInteraction,
    setSessionCompletion,
    syncInferredMetadata,
    pruneExpiredHidden,
  };
}
