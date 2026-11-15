import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { ChatGPTActivityState } from "./components/sidebar/chatGPTActivity";

export const SPAWN_AUTO_CLOSE_IDLE_MS = 2 * 60 * 60_000;
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

/** An observed idle transition is durable; actual work resets it. */
export function observeSpawnAutoCloseActivity(
  environmentId: string,
  session: BrowserSession,
  activity: ChatGPTActivityState,
  now = Date.now(),
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = window.localStorage,
): void {
  if (!isSpawnedWorker(session)) return;
  const name = key(environmentId, session.id);
  try {
    if (activity === "idle") {
      if (readSpawnAutoCloseIdleSince(environmentId, session.id, storage) === null)
        storage.setItem(name, String(now));
    } else if (activity === "working") {
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

/** Shared protection for explicit opt-in workers, including cold task-completion fallback. */
export function isSpawnedWorker(session: BrowserSession): boolean {
  return !!session.spawnRequestId && (session.autoClose === true ||
    (session.creationOrigin === "backend" && session.binding?.role === "worker"));
}

function eligibleForAutoClose(
  sessions: readonly BrowserSession[],
  session: BrowserSession,
): boolean {
  return isSpawnedWorker(session) &&
    !session.hidden &&
    !session.humanControlled &&
    !session.autoCloseExempt &&
    !session.returnMarker &&
    !session.verificationPending &&
    session.snoozedUntil === undefined &&
    !session.borderColor &&
    session.binding?.role !== "manager" &&
    !sessions.some((child) => child.parentSessionId === session.id);
}

export function spawnAutoCloseCandidate(
  sessions: readonly BrowserSession[],
  session: BrowserSession,
  now: number,
  idleSince: number | null,
  lastWorkingAt: number | null = null,
  spawnCreatedAt: number | null = null,
): { taskIds: []; dueAt: number; reason: "auto-close-idle" } | null {
  if (!eligibleForAutoClose(sessions, session)) return null;
  // Last observed work wins over older idle observations; unmounted workers
  // can still expire using durable work/spawn evidence.
  const activityAt = Math.max(
    idleSince ?? 0, lastWorkingAt ?? 0, spawnCreatedAt ?? 0,
    session.createdAt ?? 0, session.lastDirectInteractionAt ?? 0,
  );
  if (!Number.isFinite(activityAt) || activityAt <= 0 || activityAt > now ||
      now - activityAt < SPAWN_AUTO_CLOSE_IDLE_MS) return null;
  return { taskIds: [], dueAt: activityAt + SPAWN_AUTO_CLOSE_IDLE_MS, reason: "auto-close-idle" };
}
