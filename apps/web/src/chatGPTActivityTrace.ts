/** Bounded, content-free evidence for delayed ChatGPT sidebar status changes. */
export interface ChatGPTActivityTraceEvent {
  readonly at: number;
  readonly sessionId: string;
  readonly event: "push" | "transition" | "display" | "slow-probe" | "unhealthy-heartbeat";
  readonly detail: string;
}

const MAX_EVENTS = 350;
const key = (environmentId: string) => `t3code:chatgpt-browser:activity-trace:v1:${environmentId}`;

/** Read the trace without touching session or recovery state. */
export function readChatGPTActivityTrace(environmentId: string): ChatGPTActivityTraceEvent[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(environmentId)) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (entry): entry is ChatGPTActivityTraceEvent =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.at === "number" &&
          typeof entry.sessionId === "string" &&
          typeof entry.event === "string" &&
          typeof entry.detail === "string",
      )
      .slice(-MAX_EVENTS);
  } catch {
    return [];
  }
}

/** Only discrete transitions and anomalous probes are recorded; never chat text, drafts, or URLs. */
export function recordChatGPTActivityTrace(
  environmentId: string,
  sessionId: string,
  event: ChatGPTActivityTraceEvent["event"],
  detail: string,
): void {
  try {
    const current = readChatGPTActivityTrace(environmentId);
    const at = Date.now();
    const previous = current.findLast(
      (entry) => entry.sessionId === sessionId && entry.event === event,
    );
    // Frequent unhealthy heartbeat reads should not fill the trace.
    if (event === "unhealthy-heartbeat" && previous && at - previous.at < 60_000) return;
    const next = [...current, { at, sessionId, event, detail: detail.slice(0, 220) }].slice(
      -MAX_EVENTS,
    );
    localStorage.setItem(key(environmentId), JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("chatgpt-activity-trace-updated"));
  } catch {
    // Diagnostics must never affect session monitoring or recovery.
  }
}
