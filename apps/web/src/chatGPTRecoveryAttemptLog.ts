import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";

/** Local, content-free history; unlike the recovery queue, survives T3 restarts. */
export interface ChatGPTRecoveryAttemptLogEntry {
  readonly at: number;
  readonly kind: "attempt" | "backoff" | "deferred" | "outcome";
  readonly sessionId: string;
  readonly sessionName: string;
  readonly attemptNumber: number;
  readonly detail: string;
  readonly pauseUntil?: number;
}
const EVENT = "chatgpt-recovery-attempt-log-updated";
const KEY = (environmentId: string) => `t3code:chatgpt-browser:attempt-history:v1:${environmentId}`;
const MAX_ENTRIES = 5000;

export function readChatGPTRecoveryAttemptLog(environmentId: string): ChatGPTRecoveryAttemptLogEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY(environmentId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is ChatGPTRecoveryAttemptLogEntry =>
      value !== null && typeof value === "object" &&
      Number.isFinite(value.at) && value.at > 0 &&
      (value.kind === "attempt" || value.kind === "backoff" || value.kind === "deferred" || value.kind === "outcome") &&
      typeof value.sessionId === "string" && typeof value.sessionName === "string" &&
      Number.isSafeInteger(value.attemptNumber) && value.attemptNumber >= 0 &&
      typeof value.detail === "string",
    ).slice(-MAX_ENTRIES);
  } catch { return []; }
}

export function recordChatGPTRecoveryAttemptLog(
  environmentId: string,
  input: Omit<ChatGPTRecoveryAttemptLogEntry, "sessionName">,
): void {
  try {
    const title = getChatGPTSessionPersistedStore(environmentId).getState().sessions
      .find((session) => session.id === input.sessionId)?.title ?? input.sessionId;
    const entry: ChatGPTRecoveryAttemptLogEntry = {
      ...input, sessionName: input.kind === "backoff" ? "All ChatGPT sessions" : title,
    };
    const next = [...readChatGPTRecoveryAttemptLog(environmentId), entry].slice(-MAX_ENTRIES);
    window.localStorage.setItem(KEY(environmentId), JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // Diagnostics are best-effort and must never interrupt recovery attempts.
  }
}
export function subscribeChatGPTRecoveryAttemptLog(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
