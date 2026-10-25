/** Bounded, content-free diagnostic history readable through T3 session control. */
export interface ChatGPTRecoveryEvent {
  readonly at: number;
  readonly sessionId: string;
  readonly event: string;
  readonly detail?: string;
}

const MAX_EVENTS = 250;
const logKey = (environmentId: string) => `t3code:chatgpt-browser:recovery-log:${environmentId}`;

export function readChatGPTRecoveryEvents(
  environmentId: string,
  sessionId: string,
  count = 20,
): ChatGPTRecoveryEvent[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(logKey(environmentId)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is ChatGPTRecoveryEvent =>
          !!item &&
          typeof item === "object" &&
          item.sessionId === sessionId &&
          typeof item.at === "number" &&
          typeof item.event === "string",
      )
      .slice(-Math.max(1, Math.min(count, 50)));
  } catch {
    return [];
  }
}

export function recordChatGPTRecoveryEvent(
  environmentId: string,
  sessionId: string,
  event: string,
  detail?: string,
): void {
  const current = readAllEvents(environmentId);
  const now = Date.now();
  const last = current.findLast(
    (item) => item.sessionId === sessionId && item.event === event && item.detail === detail,
  );
  // Repeated scan/cooldown observations must not flood the log.
  if (last && now - last.at < 60_000) return;
  const entry: ChatGPTRecoveryEvent = {
    at: now,
    sessionId,
    event,
    ...(detail ? { detail: detail.slice(0, 160) } : {}),
  };
  console.info("[ChatGPT recovery]", entry);
  try {
    localStorage.setItem(
      logKey(environmentId),
      JSON.stringify([...current, entry].slice(-MAX_EVENTS)),
    );
  } catch {
    // Diagnostic writes must never block recovery.
  }
}

function readAllEvents(environmentId: string): ChatGPTRecoveryEvent[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(logKey(environmentId)) ?? "[]");
    return Array.isArray(value) ? value.slice(-MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

/** Persisted scheduler state, not proof that a reload completed successfully. */
export function readChatGPTRecoveryState(environmentId: string, sessionId: string) {
  try {
    const root: unknown = JSON.parse(
      localStorage.getItem(`t3code:chatgpt-browser:bounded-recovery:${environmentId}`) ?? "{}",
    );
    const history: unknown = JSON.parse(
      localStorage.getItem(`t3code:chatgpt-browser:recovery:${environmentId}`) ?? "{}",
    );
    const state = root && typeof root === "object" ? (root as Record<string, unknown>) : {};
    const info = history && typeof history === "object" ? (history as Record<string, unknown>) : {};
    const red =
      state.red && typeof state.red === "object"
        ? (state.red as Record<string, unknown>)[sessionId]
        : undefined;
    const orange =
      state.orange && typeof state.orange === "object"
        ? (state.orange as Record<string, unknown>)[sessionId]
        : undefined;
    const bySession =
      info.bySession && typeof info.bySession === "object"
        ? (info.bySession as Record<string, unknown>)[sessionId]
        : undefined;
    const r = red && typeof red === "object" ? (red as Record<string, unknown>) : {};
    const o = orange && typeof orange === "object" ? (orange as Record<string, unknown>) : {};
    return {
      lastAttemptAt: typeof bySession === "number" ? bySession : null,
      retryCount: typeof r.attempts === "number" ? r.attempts : 0,
      // Red failures have no per-session cooldown; the global queue is the limit.
      nextRetryAt: null,
      orangeStage: typeof o.stage === "string" ? o.stage : null,
      // A legacy escalation must never hide a recovery candidate or stop wakeup.
      escalationReason: null,
    };
  } catch {
    return {
      lastAttemptAt: null,
      retryCount: 0,
      nextRetryAt: null,
      orangeStage: null,
      escalationReason: null,
    };
  }
}

// Episode metrics deliberately require explicit verified outcomes; legacy events are not backfilled.
export {
  aggregateChatGPTRecoveryMetrics,
  readChatGPTRecoveryMetrics,
  recordChatGPTRecoveryMetric,
} from "./chatGPTRecoveryMetrics";
