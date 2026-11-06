import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { TaskBoardWorkerClaim } from "./chatGPTCompletedWorkerPolicy";
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

/** Shared protection for explicit opt-in workers, including cold task-completion fallback. */
function eligibleForAutoClose(
  sessions: readonly BrowserSession[],
  session: BrowserSession,
  activeSessionId: string | undefined,
): boolean {
  return session.autoClose === true &&
    !!session.spawnRequestId &&
    !session.hidden &&
    !session.humanControlled &&
    !session.autoCloseExempt &&
    !session.verificationPending &&
    session.snoozedUntil === undefined &&
    !session.borderColor &&
    session.binding?.role !== "manager" &&
    session.id !== activeSessionId &&
    !sessions.some((child) => child.parentSessionId === session.id);
}

export function spawnAutoCloseCandidate(
  sessions: readonly BrowserSession[],
  session: BrowserSession,
  activeSessionId: string | undefined,
  now: number,
  idleSince: number | null,
): { taskIds: []; dueAt: number; reason: "auto-close-idle" } | null {
  if (
    !eligibleForAutoClose(sessions, session, activeSessionId) ||
    idleSince === null ||
    !Number.isFinite(idleSince) ||
    idleSince <= 0 ||
    idleSince > now ||
    now - idleSince < SPAWN_AUTO_CLOSE_IDLE_MS
  ) return null;
  return { taskIds: [], dueAt: idleSince + SPAWN_AUTO_CLOSE_IDLE_MS, reason: "auto-close-idle" };
}

/**
 * A task-bound worker can become unmounted before the idle observer records
 * its final transition. Only the authoritative completion of the EXACT bound
 * TaskBoard task can substitute for that lost observation, and only when the
 * guest is independently confirmed absent by the cleanup owner.
 *
 * This is NOT a generic "unavailable means idle" rule. It is a fail-safe for
 * explicit auto-close workers with a finished, verified assignment.
 */
export function spawnAutoCloseFinishedTaskCandidate(
  sessions: readonly BrowserSession[],
  session: BrowserSession,
  claims: readonly (TaskBoardWorkerClaim & { boardRoot?: string })[],
  activeSessionId: string | undefined,
  now: number,
  lastWorkingAt: number | null,
): { taskIds: string[]; dueAt: number; reason: "auto-close-finished-task" } | null {
  if (!eligibleForAutoClose(sessions, session, activeSessionId)) return null;
  const binding = session.binding;
  if (binding?.role !== "worker" || binding.boundBy !== "omcp_spawn" || !binding.taskRef)
    return null;
  const samePath = (path: string) => path.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
  const task = claims.find((row) =>
    row.taskId === binding.taskRef!.id &&
    typeof row.boardRoot === "string" &&
    samePath(row.boardRoot) === samePath(binding.taskRef!.board),
  );
  const completedAt = task?.completedAt;
  const boundAt = Date.parse(binding.boundAt);
  if (!task || task.column !== "done" || task.liveState ||
      completedAt === null || completedAt === undefined ||
      !Number.isFinite(completedAt) || !Number.isFinite(boundAt) ||
      completedAt < boundAt || completedAt > now ||
      (lastWorkingAt !== null && (!Number.isFinite(lastWorkingAt) || lastWorkingAt > now)) ||
      // Do not close an agent that also owns an unfinished task on another board.
      claims.some((row) => row.taskId !== task.taskId &&
        row.claimedBy.toLowerCase().replace(/^t3(?:-browser)?:/, "") === session.id.toLowerCase() &&
        row.column !== "done"))
    return null;
  const dueAt = Math.max(completedAt, lastWorkingAt ?? 0, session.lastDirectInteractionAt ?? 0) +
    SPAWN_AUTO_CLOSE_IDLE_MS;
  return dueAt <= now ? {
    taskIds: [task.taskId], dueAt, reason: "auto-close-finished-task",
  } : null;
}
