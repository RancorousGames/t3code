import { chatGPTSessionCreationOrigin, type BrowserSession } from "./chatGPTBrowserSessions";

export interface TaskBoardWorkerClaim {
  taskId: string;
  claimedBy: string;
  column: string;
  completedAt: number | null;
  handoffAt?: number | null;
}

export const WORKER_DONE_GRACE_MS = 2 * 60 * 60_000;
export const WORKER_UNASSIGNED_GRACE_MS = 2 * 60 * 60_000;
export const WORKER_MAX_AGE_MS = 24 * 60 * 60_000;

export interface WorkerCreationEvidence {
  /** Exact backend reservation created timestamp, obtained from the spawn journal. */
  spawnCreatedAt?: number;
  /** Lower bound: the worker must have existed when it was last working. */
  lastWorkingAt?: number;
}

export interface WorkerCloseCandidate {
  taskIds: string[];
  dueAt: number;
  reason: "all-tasks-done" | "all-tasks-handed-off" | "unassigned-two-hours" | "worker-24-hours";
}

const TASK_ID = /\b[A-Z][A-Z0-9]{1,7}-\d{3,6}\b/g;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function taskBelongsToWorker(task: TaskBoardWorkerClaim, session: BrowserSession): boolean {
  const claim = task.claimedBy.toLowerCase().trim();
  const id = session.id.toLowerCase();
  if (claim === id || (UUID.test(id) && claim.includes(id))) return true;
  // TaskBoard historically used labels such as T3-worker-67cbb8ca or
  // GPT6-WT0173-84708039. Never match a short ID inside a longer hex token.
  const shortId = id.slice(0, 8);
  if (UUID.test(id) && new RegExp(`(?:^|[^0-9a-f])${shortId}(?:$|[^0-9a-f])`, "i").test(claim))
    return true;
  // A task mentioned explicitly in the worker title is an association even
  // when another worker holds the TaskBoard claim (e.g. UI delegates).
  const titledIds: string[] = session.title.toUpperCase().match(TASK_ID) ?? [];
  return titledIds.includes(task.taskId.toUpperCase());
}

function creationLowerBound(
  session: BrowserSession,
  evidence: WorkerCreationEvidence,
  now: number,
): number | null {
  const valid = (value: number | undefined): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now;
  if (valid(session.markedAsWorkerAt)) return session.markedAsWorkerAt;
  if (valid(session.createdAt)) return session.createdAt;
  if (valid(evidence.spawnCreatedAt)) return evidence.spawnCreatedAt;
  // lastWorkingAt does not establish exact creation; it does prove a minimum
  // age. This intentionally delays legacy cleanup instead of backdating it.
  return valid(evidence.lastWorkingAt) ? evidence.lastWorkingAt : null;
}

/** One source of worker role truth: backend-created, not human-adopted, not a manager.
 * The sidebar's lavender tint uses this same creation-origin + adoption rule.
 * Selection/click timestamps do NOT change worker identity or expiry.
 */
export function completedWorkerCandidate(
  sessions: readonly BrowserSession[],
  session: BrowserSession,
  claims: readonly TaskBoardWorkerClaim[],
  managerIds: ReadonlySet<string> | null,
  activeSessionId: string | undefined,
  now: number,
  evidence: WorkerCreationEvidence = {},
): WorkerCloseCandidate | null {
  // No manager-seat ledger means no automatic deletion.
  if (
    managerIds === null ||
    (session.markedAsWorkerAt === undefined &&
      chatGPTSessionCreationOrigin(session) !== "backend") ||
    managerIds.has(session.id) ||
    /\b(manager|coordinator)\b/i.test(session.title) ||
    session.humanControlled === true ||
    session.id === "chatgpt" ||
    sessions.some((entry) => entry.parentSessionId === session.id) ||
    session.hidden ||
    session.autoCloseExempt ||
    !!session.borderColor ||
    session.snoozedUntil !== undefined ||
    session.id === activeSessionId
  )
    return null;

  // Detached/orphaned parent metadata cannot authorize a deletion.
  if (session.parentSessionId && !sessions.some((entry) => entry.id === session.parentSessionId))
    return null;

  const bornNoLaterThan = creationLowerBound(session, evidence, now);
  const owned = claims.filter((task) => taskBelongsToWorker(task, session));
  const allDone =
    owned.length > 0 &&
    owned.every(
      (task) =>
        task.column === "done" &&
        task.completedAt !== null &&
        Number.isFinite(task.completedAt) &&
        task.completedAt > 0 &&
        task.completedAt <= now,
    );

  const handedOff =
    owned.length > 0 &&
    owned.every(
      (task) =>
        (task.column === "done" &&
          task.completedAt !== null &&
          Number.isFinite(task.completedAt) &&
          task.completedAt > 0 &&
          task.completedAt <= now) ||
        (task.handoffAt !== null &&
          task.handoffAt !== undefined &&
          Number.isFinite(task.handoffAt) &&
          task.handoffAt > 0 &&
          task.handoffAt <= now),
    );
  const due: WorkerCloseCandidate[] = [];
  if (handedOff && !allDone) {
    due.push({
      taskIds: owned.map((task) => task.taskId),
      dueAt:
        Math.max(
          ...owned.map((task) => (task.column === "done" ? task.completedAt! : task.handoffAt!)),
          session.markedAsWorkerAt ?? 0,
        ) + WORKER_DONE_GRACE_MS,
      reason: "all-tasks-handed-off",
    });
  }
  if (allDone) {
    due.push({
      taskIds: owned.map((task) => task.taskId),
      dueAt:
        Math.max(...owned.map((task) => task.completedAt!), session.markedAsWorkerAt ?? 0) +
        WORKER_DONE_GRACE_MS,
      reason: "all-tasks-done",
    });
  }
  if (bornNoLaterThan !== null) {
    if (!owned.length) {
      due.push({
        taskIds: [],
        dueAt: bornNoLaterThan + WORKER_UNASSIGNED_GRACE_MS,
        reason: "unassigned-two-hours",
      });
    }
    due.push({
      taskIds: owned.map((task) => task.taskId),
      dueAt: bornNoLaterThan + WORKER_MAX_AGE_MS,
      reason: "worker-24-hours",
    });
  }
  // An In Progress task prevents the 2-hour unassigned rule, but cannot
  // override the 24-hour cap. Missing birth evidence fails closed.
  const eligible = due.filter((item) => item.dueAt <= now);
  eligible.sort((a, b) => a.dueAt - b.dueAt);
  return eligible[0] ?? null;
}
