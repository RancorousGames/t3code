/** Scheduler-advisory progress, never a dispatch permission or successful-load claim. */
export interface PendingSessionProgress {
  readonly kind: "warm" | "recovery";
  readonly rank: number;
  readonly estimatedAt: number;
  readonly progress: number;
  readonly title: string;
}

// Distinct priority bands mean a row nearer the front remains visibly fuller
// even if an older, lower-priority attempt has waited for many cycles.
function priorityBand(rank: number): { low: number; high: number } {
  if (rank === 1) return { low: 0.68, high: 0.96 };
  if (rank === 2) return { low: 0.48, high: 0.66 };
  if (rank === 3) return { low: 0.32, high: 0.46 };
  // Nonoverlapping bands at every rank, including a long backlog.
  const high = 1.2 / rank;
  const low = (high + 1.2 / (rank + 1)) / 2;
  return { low, high };
}

/** Overdue forecasts roll back rather than freezing at 98%. New blockers, rank
 * changes or scheduler delays may legitimately reduce the visible fill. */
function adaptiveProgress(
  now: number,
  rank: number,
  deadline: number,
  cycleMs: number,
  observedStartAt: number,
): { progress: number; estimatedAt: number } {
  const { low, high } = priorityBand(rank);
  const horizon = Math.max(cycleMs, deadline - observedStartAt);
  const fraction = now < deadline
    ? Math.max(0, Math.min(0.999, (now - (deadline - horizon)) / horizon))
    : ((now - deadline) % cycleMs) / cycleMs;
  const estimatedAt = now < deadline
    ? deadline
    : deadline + (Math.floor((now - deadline) / cycleMs) + 1) * cycleMs;
  return { progress: low + (high - low) * fraction, estimatedAt };
}

export function pendingSessionProgress(input: {
  now: number;
  id: string;
  /** The single auto-maintenance toggle suppresses every automatic progress indicator. */
  paused?: boolean;
  warm?: readonly { id: string; notBefore: number; ordinal: number }[];
  recovery?: readonly string[];
  recoveryNextRetryAt?: number | null;
  recoveryLastAttemptAt?: number | null;
  recoveryQueuedAt?: number | null;
  activeWarmStartedAt?: number | null;
}): PendingSessionProgress | null {
  if (input.paused) return null;
  const { id, now } = input;
  const recoveryIndex = input.recovery?.indexOf(id) ?? -1;
  if (recoveryIndex >= 0) {
    const rank = recoveryIndex + 1;
    const cycleMs = rank * 20_000;
    const anchor = input.recoveryLastAttemptAt || input.recoveryQueuedAt || now;
    const deadline = Math.max(anchor + cycleMs, input.recoveryNextRetryAt ?? 0) + recoveryIndex * 20_000;
    const estimate = adaptiveProgress(now, rank, deadline, cycleMs, anchor);
    return { kind: "recovery", rank, ...estimate,
      title: `Recovery priority #${rank}. Approximate next opportunity in ${Math.ceil(Math.max(0, estimate.estimatedAt - now) / 1000)}s; forecast adjusts if retries take longer.` };
  }
  if (typeof input.activeWarmStartedAt === "number" && input.activeWarmStartedAt > 0) {
    const rank = 1;
    const estimate = adaptiveProgress(now, rank, input.activeWarmStartedAt + 45_000, 15_000, input.activeWarmStartedAt);
    return { kind: "warm", rank, ...estimate,
      title: `Guest loading now. Attach-window estimate ${Math.ceil(Math.max(0, estimate.estimatedAt - now) / 1000)}s; may reset if load stalls.` };
  }
  const warm = input.warm?.find((entry) => entry.id === id);
  if (!warm) return null;
  const rank = warm.ordinal + 1;
  const cycleMs = Math.max(12_000, rank * 12_000);
  const estimate = adaptiveProgress(now, rank, warm.notBefore, cycleMs, warm.notBefore - cycleMs);
  return { kind: "warm", rank, ...estimate,
    title: `Warm-load priority #${rank}. Earliest estimated start in ${Math.ceil(Math.max(0, estimate.estimatedAt - now) / 1000)}s; timing may change.` };
}
