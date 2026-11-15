/** Bounded TaskBoard queue recovery. Pure policy; the coordinator executes
 * only CAS-protected CLI transitions after reading the complete T3 registry. */
export type RecoveryPhase =
  | "queued" | "reserved" | "starting" | "working" | "completed" | "recovery_required";

export interface RecoveryQueueItem {
  taskId: string;
  state: RecoveryPhase;
  stateSince?: string | null;
  queueRequest: string;
  reservationId?: string | null;
  reservationExpiresAt?: string | null;
  sessionId?: string | null;
  claimed: boolean;
  readiness: boolean;
  legacyOpenRig: boolean;
}

export interface RecoverySession {
  id: string;
  spawnRequestId?: string;
  conversationId?: string | null;
  bootstrapIdentity?: { state?: string; conversationId?: string | null };
  status?: string;
  activity?: string;
  lastRole?: string | null;
  totalTurns?: number | null;
  lastWorkingAt?: number | null;
  closedAt?: unknown;
  binding?: { taskRef?: {board?: string; id?: string} };
}

export type RecoveryAction = "expire" | "abandon" | "working" | "requeue-released" | "incident";
export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
  sessionId?: string;
}

const STARTING_DEADLINE = 45 * 60_000;
const MISSING_SPAWN_GRACE = 30 * 60_000;
const WORKER_DEADLINE = 90 * 60_000;
const LEASE_DEADLINE = 15 * 60_000;
const NO_PROGRESS_DEADLINE = 12 * 60 * 60_000;
const MALFORMED_DEADLINE = 15 * 60_000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Never interpret an absent/malformed clock as infinite age. The caller
 * supplies a persisted first-observed timestamp for legacy queue rows. */
export function decideQueueRecovery(
  item: RecoveryQueueItem,
  exactSessions: readonly RecoverySession[],
  now: number,
  firstObservedAt: number,
): RecoveryDecision | null {
  if (item.legacyOpenRig || item.state === "completed" ||
      item.state === "recovery_required") return null;
  const stamped = Date.parse(item.stateSince ?? "");
  const entered = Number.isFinite(stamped) && stamped <= now
    ? stamped : Math.min(now, firstObservedAt);
  const age = Math.max(0, now - entered);
  if (item.state === "queued") {
    return !UUID.test(item.queueRequest ?? "") && age >= MALFORMED_DEADLINE
      ? { action: "incident", reason: "Queued task has no valid queue request identity; dispatcher cannot reserve it." }
      : null;
  }
  if (!item.reservationId || !UUID.test(item.queueRequest ?? "") ||
      !UUID.test(item.reservationId)) {
    return age >= MALFORMED_DEADLINE
      ? { action: "incident", reason: "In-flight queue task has missing or malformed ownership identity." }
      : null;
  }
  const owned = exactSessions.filter(session => session.spawnRequestId === item.reservationId);

  if (item.state === "reserved") {
    const expires = Date.parse(item.reservationExpiresAt ?? "");
    if (Number.isFinite(expires) && now >= expires) {
      return { action: "expire", reason: "Pre-spawn lease expired; no session was authorized." };
    }
    if (!Number.isFinite(expires) && age >= LEASE_DEADLINE) {
      return { action: "incident", reason: "Reserved lease metadata unreadable past the recovery deadline." };
    }
    return null;
  }

  if (item.state === "starting") {
    if (owned.length === 1) {
      const session = owned[0]!;
      if (session.closedAt != null && !session.conversationId &&
          !session.bootstrapIdentity?.conversationId &&
          (session.totalTurns ?? 0) === 0 && age >= MISSING_SPAWN_GRACE) {
        return { action: "abandon", reason: "Exact guest definitively closed before any verified conversation." };
      }
      if (session.closedAt == null && session.conversationId &&
          session.bootstrapIdentity?.state === "registered" &&
          session.bootstrapIdentity.conversationId === session.conversationId &&
          session.lastRole === "assistant" && (session.totalTurns ?? 0) >= 1) {
        return { action: "working", sessionId: session.id,
          reason: "Exact registered conversation has an assistant response." };
      }
    } else if (owned.length === 0 && age >= MISSING_SPAWN_GRACE) {
      return { action: "abandon", reason: "No exact spawned session in the complete registry after 30 minutes." };
    }
    if (age >= STARTING_DEADLINE) {
      return { action: "incident", reason: owned.length > 1
        ? "Multiple sessions claim the same Starting request."
        : "Starting request exceeded 45 minutes without verifiable completion; original prompt may have been delivered." };
    }
    return null;
  }

  // A real worker can remain idle for a long time without losing ownership.
  // Recovery must not interrupt it just because its task is unfinished.
  const exact = owned.length === 1 ? owned[0] : undefined;
  const validSession = exact && exact.id === item.sessionId && exact.closedAt == null &&
    exact.conversationId && exact.bootstrapIdentity?.state === "registered" &&
    exact.bootstrapIdentity.conversationId === exact.conversationId;
  if (validSession) {
    // A valid conversation can still wedge forever after a lost Caffy wake.
    // Do not cancel it automatically; make the stalled ownership visible.
    const lastProgress = Math.max(entered, exact?.lastWorkingAt ?? 0);
    return now - lastProgress >= NO_PROGRESS_DEADLINE
      ? { action: "incident", reason: "Verified worker has made no observable progress for 12 hours; ownership preserved." }
      : null;
  }

  if (age < WORKER_DEADLINE) return null;
  if (!item.claimed && item.sessionId && item.readiness &&
      (owned.length === 0 || (exact?.id === item.sessionId && exact.closedAt != null))) {
    return { action: "requeue-released",
      reason: "Unclaimed Working receipt has no live exact session after 90 minutes." };
  }
  return { action: "incident", reason: owned.length > 1
    ? "Multiple sessions claim the same Working request."
    : "Working ownership cannot be verified after 90 minutes; preserved claim and possible remote work." };
}
