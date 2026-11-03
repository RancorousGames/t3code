import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import { readChatGPTSessionProfileId } from "./chatGPTAccountProfiles";

/** Content-free, restart-persistent diagnostics for a human-readable startup/recovery timeline.
 * Every item is an observation, not a claim that navigation or recovery succeeded. */
export type RecoveryTimelineBackend = "native" | "webview" | "all";
export type RecoveryTimelineKind =
  | "startup"
  | "priority"
  | "click"
  | "attempt"
  | "outcome"
  | "health"
  | "deferred"
  | "retry"
  | "backoff";

export interface RecoveryTimelineItem {
  at: number;
  run: string;
  backend: RecoveryTimelineBackend;
  kind: RecoveryTimelineKind;
  detail: string;
  sessionId?: string;
  sessionTitle?: string;
  attempt?: number;
  nextAt?: number;
  order?: readonly { id: string; title: string; reason: string }[];
  scheduled?: readonly string[];
  schedule?: readonly { id: string; earliestAt: number }[];
}

const KEY = (environmentId: string) =>
  `t3code:chatgpt-browser:recovery-timeline:v1:${environmentId}`;
const MAX_ITEMS = 3000;
const currentRuns = new Map<string, string>();
const attempts = new Map<string, number>();
const lastPriorities = new Map<string, string>();
const lastHealth = new Map<string, string>();

const titleFor = (environmentId: string, sessionId: string) =>
  getChatGPTSessionPersistedStore(environmentId)
    .getState()
    .sessions.find((session) => session.id === sessionId)?.title ?? sessionId;

export function readChatGPTRecoveryTimeline(environmentId: string): RecoveryTimelineItem[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(KEY(environmentId)) ?? "[]");
    return Array.isArray(data)
      ? data
          .filter(
            (item): item is RecoveryTimelineItem =>
              !!item &&
              typeof item === "object" &&
              Number.isFinite(item.at) &&
              typeof item.run === "string" &&
              typeof item.kind === "string" &&
              typeof item.detail === "string" &&
              typeof item.backend === "string",
          )
          .slice(-MAX_ITEMS)
      : [];
  } catch {
    return [];
  }
}

export function logChatGPTRecoveryTimeline(
  environmentId: string,
  backend: RecoveryTimelineBackend,
  kind: RecoveryTimelineKind,
  detail: string,
  extra: Partial<
    Pick<
      RecoveryTimelineItem,
      "sessionId" | "attempt" | "nextAt" | "order" | "scheduled" | "schedule"
    >
  > = {},
): void {
  try {
    // First call marks the current renderer lifetime. A restart produces a new run.
    let run = currentRuns.get(environmentId);
    if (!run) {
      run = `${Date.now()}-${Math.trunc(performance.now())}`;
      currentRuns.set(environmentId, run);
    }
    const entry: RecoveryTimelineItem = {
      at: kind === "startup" ? Math.trunc(performance.timeOrigin) : Date.now(),
      run,
      backend,
      kind,
      detail,
      ...extra,
      ...(extra.sessionId ? { sessionTitle: titleFor(environmentId, extra.sessionId) } : {}),
    };
    // Mirror real native recovery observations to an on-disk NDJSON audit.
    // The host accepts these even if no Chromium page is currently resident.
    // This record is not a claim that a queued action was actually dispatched.
    if (backend === "native" && extra.sessionId) {
      const bridge = window.desktopBridge?.stableChatGPTViewRequest;
      if (bridge) {
        void Promise.resolve(bridge({
          operation: "recovery_event",
          identity: {
            environmentId, sessionId: extra.sessionId,
            profileId: readChatGPTSessionProfileId(environmentId, extra.sessionId),
          },
          kind, detail: detail.slice(0, 220),
          ...(extra.attempt !== undefined ? { attempt: extra.attempt } : {}),
        })).catch((error: unknown) =>
          console.warn("[ChatGPT recovery] Native audit write failed:", error));
      }
    }
    localStorage.setItem(
      KEY(environmentId),
      JSON.stringify([...readChatGPTRecoveryTimeline(environmentId), entry].slice(-MAX_ITEMS)),
    );
    window.dispatchEvent(new Event("chatgpt-recovery-timeline-updated"));
  } catch {
    /* Never interfere with page loading or recovery. */
  }
}

export function beginChatGPTRecoveryTimeline(
  environmentId: string,
  backend: RecoveryTimelineBackend,
  detail: string,
): void {
  const key = `${environmentId}:${backend}:startup`;
  if (lastPriorities.has(key)) return;
  lastPriorities.set(key, "started");
  logChatGPTRecoveryTimeline(environmentId, backend, "startup", detail);
}

/** Write a full ordered snapshot only when priorities or scheduling actually change. */
export function logChatGPTRecoveryPriority(
  environmentId: string,
  backend: RecoveryTimelineBackend,
  candidates: readonly { id: string; reason: string }[],
  scheduled: readonly string[],
  detail: string,
  scope = "warm",
  schedule: readonly { id: string; earliestAt: number }[] = [],
): void {
  const signature = JSON.stringify([candidates, scheduled]);
  const key = `${environmentId}:${backend}:priority:${scope}`;
  if (lastPriorities.get(key) === signature) return;
  lastPriorities.set(key, signature);
  logChatGPTRecoveryTimeline(environmentId, backend, "priority", detail, {
    order: candidates.map(({ id, reason }) => ({ id, title: titleFor(environmentId, id), reason })),
    scheduled: [...scheduled],
    schedule: [...schedule],
  });
}

/** Only real browser load requests are counted; status probes and scheduler ticks are not retries. */
export function logChatGPTRecoveryAttempt(
  environmentId: string,
  backend: RecoveryTimelineBackend,
  sessionId: string,
  detail: string,
): number {
  const key = `${environmentId}:${backend}:${sessionId}`;
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);
  logChatGPTRecoveryTimeline(environmentId, backend, "attempt", detail, { sessionId, attempt });
  return attempt;
}

/** Deduplicate repetitive polling observations; retain meaningful state changes. */
export function logChatGPTRecoveryHealth(
  environmentId: string,
  backend: RecoveryTimelineBackend,
  sessionId: string,
  state: string,
  detail: string,
): void {
  const source = state.startsWith("chatgpt:") ? "dom" : "host";
  const key = `${environmentId}:${backend}:${sessionId}:${source}`;
  if (lastHealth.get(key) === state) return;
  lastHealth.set(key, state);
  logChatGPTRecoveryTimeline(environmentId, backend, "health", detail, { sessionId });
}

export function formatChatGPTRecoveryTimeline(
  items: readonly RecoveryTimelineItem[],
  now = Date.now(),
): string {
  const lines = [
    "T3 ChatGPT — session loading & recovery",
    "======================================",
    "",
  ];
  const byRun = new Map<string, RecoveryTimelineItem[]>();
  for (const item of items) {
    const group = byRun.get(item.run) ?? [];
    group.push(item);
    byRun.set(item.run, group);
  }
  if (!items.length) return [...lines, "No recovery timeline events recorded yet.", ""].join("\n");
  const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });
  const elapsed = (at: number, start: number) => {
    const seconds = Math.max(0, Math.floor((at - start) / 1000));
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
  };
  for (const [run, group] of byRun) {
    group.sort((a, b) => a.at - b.at);
    const start = group[0]!.at;
    lines.push(`RESTART / RUN — ${new Date(start).toLocaleString()}  [${run.slice(0, 8)}]`, "");
    for (const item of group) {
      const label = item.sessionTitle ? `"${item.sessionTitle}"` : "";
      const nth = item.attempt
        ? ` (${item.attempt === 1 ? "1st" : item.attempt === 2 ? "2nd" : item.attempt === 3 ? "3rd" : item.attempt + "th"} attempt)`
        : "";
      const suffix = item.nextAt ? `  Next eligible: ${clock(item.nextAt)}` : "";
      lines.push(
        `${elapsed(item.at, start).padStart(7)}  ${clock(item.at)}  [${item.backend}] ${item.kind.toUpperCase()}${label ? " — " + label : ""}${nth}`,
      );
      lines.push(`                  ${item.detail}${suffix}`);
      if (item.order) {
        lines.push("                  Priority (high -> low):");
        item.order.forEach((s, n) =>
          lines.push(`                    ${n + 1}. ${s.title}  [${s.reason}]`),
        );
        if (item.scheduled) {
          const lookup = new Map(item.order.map(({ id, title }) => [id, title]));
          lines.push(
            `                  Queued to load: ${
              item.scheduled
                .map((id) => {
                  const earliest = item.schedule?.find((entry) => entry.id === id)?.earliestAt;
                  return `${lookup.get(id) ?? id}${earliest ? ` (not before ${clock(earliest)})` : ""}`;
                })
                .join(" -> ") || "(none — already resident / capacity reached)"
            }`,
          );
        }
      }
      lines.push("");
    }
  }
  lines.push(
    `Exported ${new Date(now).toLocaleString()}. This timeline distinguishes attempts, host residency, and verified page health.`,
    "",
  );
  return lines.join("\n");
}
