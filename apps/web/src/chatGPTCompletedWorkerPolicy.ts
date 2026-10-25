import type { BrowserSession } from "./chatGPTBrowserSessions";

export interface TaskBoardWorkerClaim {
  taskId: string;
  claimedBy: string;
  column: string;
  completedAt: number | null;
}

export const WORKER_DONE_GRACE_MS = 30 * 60_000;
export const WORKER_HUMAN_GRACE_MS = 2 * 60 * 60_000;

/** Exact TaskBoard claims, not idle UI or assistant assertions, establish completion. */
export function completedWorkerCandidate(
  sessions: readonly BrowserSession[],
  session: BrowserSession,
  claims: readonly TaskBoardWorkerClaim[],
  managerIds: ReadonlySet<string> | null,
  activeSessionId: string | undefined,
  now: number,
): { taskIds: string[]; dueAt: number } | null {
  // No manager topology evidence means no automatic deletion.
  if (
    !managerIds ||
    !session.parentSessionId ||
    !sessions.some((entry) => entry.id === session.parentSessionId) ||
    managerIds.has(session.id) ||
    /\b(manager|coordinator)\b/i.test(session.title) ||
    session.id === "chatgpt" ||
    sessions.some((entry) => entry.parentSessionId === session.id) ||
    session.hidden ||
    session.autoCloseExempt ||
    !!session.borderColor ||
    session.snoozedUntil !== undefined ||
    session.id === activeSessionId
  )
    return null;

  const owned = claims.filter((task) => task.claimedBy === session.id.toLowerCase());
  if (
    !owned.length ||
    owned.some(
      (task) =>
        task.column !== "done" ||
        !task.completedAt ||
        !Number.isFinite(task.completedAt) ||
        task.completedAt > now,
    )
  )
    return null;
  const latestDoneAt = Math.max(...owned.map((task) => task.completedAt!));
  const interactedAt = session.lastDirectInteractionAt ?? 0;
  const dueAt = Math.max(
    latestDoneAt + (interactedAt > 0 ? WORKER_HUMAN_GRACE_MS : WORKER_DONE_GRACE_MS),
    interactedAt > 0 ? interactedAt + WORKER_HUMAN_GRACE_MS : 0,
  );
  return now >= dueAt ? { taskIds: owned.map((task) => task.taskId), dueAt } : null;
}
