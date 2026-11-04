import type { T3CaffyEntry, T3CaffyOverview } from "../hooks/useT3CaffyOverview";

export const CAFFY_PREWARM_WINDOW_MS = 30 * 60_000;

/** Caffy has first claim on a guest approaching its next automatic wake.
 * A delayed begin overrides its pending idle flag until the start deadline.
 * A continuous idle monitor is ready whenever the assistant next becomes idle.
 */
export function isCaffyWakeImminent(
  monitor: T3CaffyEntry,
  keepT3Busy: boolean,
  now: number,
  windowMs = CAFFY_PREWARM_WINDOW_MS,
): boolean {
  if (monitor.paused || monitor.rebootOperationId ||
      (monitor.expiresAt !== null && monitor.expiresAt <= now)) return false;
  if (monitor.mode === "queued" && !keepT3Busy) return false;
  if (typeof monitor.beginAt === "number" && monitor.beginAt > now)
    return monitor.beginAt - now <= windowMs;
  if (monitor.pendingMessageId || monitor.pendingWake) return true;
  if (monitor.mode === "idle" || monitor.mode === "queued") return true;
  if (monitor.mode === "periodic" && monitor.nextDueAt != null)
    return monitor.nextDueAt - now <= windowMs;
  return false; // Startup-only has no new due time after the launch event.
}

export function imminentCaffySessionIds(
  sessions: readonly { readonly id: string; readonly hidden?: boolean | undefined; readonly snoozedUntil?: number | undefined }[],
  overview: T3CaffyOverview | null,
  now: number,
): Set<string> {
  if (!overview) return new Set();
  const result = new Set<string>();
  for (const session of sessions) {
    if (session.hidden || (session.snoozedUntil ?? 0) > now) continue;
    if (overview.entries.some(monitor =>
      [monitor.sessionId, monitor.browserSessionId, monitor.publicSessionId].includes(session.id) &&
      isCaffyWakeImminent(monitor, overview.keepT3Busy, now)))
      result.add(session.id);
  }
  return result;
}
