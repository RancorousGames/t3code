import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { ChatGPTActivityState } from "./components/sidebar/chatGPTActivity";

export const SPAWN_AUTO_CLOSE_IDLE_MS = 60 * 60_000;
const key = (environmentId: string, sessionId: string) =>
  `t3code:chatgpt-spawn-auto-close-idle:${environmentId}:${sessionId}`;

export function readSpawnAutoCloseIdleSince(
  environmentId: string,
  sessionId: string,
  storage: Pick<Storage, "getItem"> = window.localStorage,
): number | null {
  try {
    const raw = storage.getItem(key(environmentId, sessionId));
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Only confirmed idle observations start the clock; a new turn cancels it. */
export function observeSpawnAutoCloseActivity(
  environmentId: string,
  session: BrowserSession,
  activity: ChatGPTActivityState,
  now = Date.now(),
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = window.localStorage,
): void {
  if (session.autoClose !== true || !session.spawnRequestId) return;
  const name = key(environmentId, session.id);
  try {
    if (activity === "idle") {
      if (readSpawnAutoCloseIdleSince(environmentId, session.id, storage) === null)
        storage.setItem(name, String(now));
    } else if (activity !== "unknown") {
      storage.removeItem(name);
    }
  } catch {
    // Missing storage means no durable idle proof, so automatic close is disabled.
  }
}

export function clearSpawnAutoCloseIdleSince(
  environmentId: string,
  sessionId: string,
  storage: Pick<Storage, "removeItem"> = window.localStorage,
): void {
  try { storage.removeItem(key(environmentId, sessionId)); } catch { /* unavailable */ }
}

export function spawnAutoCloseCandidate(
  sessions: readonly BrowserSession[],
  session: BrowserSession,
  activeSessionId: string | undefined,
  now: number,
  idleSince: number | null,
): { taskIds: []; dueAt: number; reason: "auto-close-idle" } | null {
  if (
    session.autoClose !== true ||
    !session.spawnRequestId ||
    session.hidden ||
    session.humanControlled ||
    session.autoCloseExempt ||
    session.verificationPending ||
    session.snoozedUntil !== undefined ||
    !!session.borderColor ||
    session.binding?.role === "manager" ||
    session.id === activeSessionId ||
    sessions.some((child) => child.parentSessionId === session.id) ||
    idleSince === null ||
    !Number.isFinite(idleSince) ||
    idleSince <= 0 ||
    idleSince > now ||
    now - idleSince < SPAWN_AUTO_CLOSE_IDLE_MS
  ) return null;
  return { taskIds: [], dueAt: idleSince + SPAWN_AUTO_CLOSE_IDLE_MS, reason: "auto-close-idle" };
}
