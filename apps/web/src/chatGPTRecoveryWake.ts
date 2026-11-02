import type { ChatGPTRecoverySettings } from "./chatGPTRecoverySettings";
import type { RecoveryQueueState } from "./components/sidebar/chatGPTRecoveryQueue";
import type { RecoveryHistory } from "./components/sidebar/chatGPTConversationRecovery";

export interface RecoveryWakeInput {
  now: number;
  settings: ChatGPTRecoverySettings;
  queue: RecoveryQueueState;
  history: RecoveryHistory;
  /** Absolute deadlines for guest hydration, orange grace, and the guarded recovery stages. */
  observationDeadlines: readonly number[];
}

/**
 * Schedules the nearest recovery deadline without polling healthy sessions.
 * The watchdog is deliberately independent of retry cadence; an overdue,
 * unverifiable guest gets a bounded recheck rather than a tight timer loop.
 */
export function recoveryNextWakeDelayMs(input: RecoveryWakeInput): number {
  const { now, settings, queue, history } = input;
  const watchdogMs = settings.watchdogSeconds * 1_000;
  let delay = watchdogMs;
  const consider = (deadline: number, blockedRetryMs = 5_000) => {
    if (!Number.isFinite(deadline) || deadline <= 0) return;
    delay = Math.min(delay, deadline <= now ? blockedRetryMs : deadline - now);
  };

  if (queue.activeRedId && queue.targets.includes(queue.activeRedId)) {
    const retryAt = Math.max(
      queue.redBackoffUntil,
      history.redLastAttemptAt ? history.redLastAttemptAt + settings.globalSeconds * 1_000 : now,
    );
    consider(retryAt);
  }
  if (queue.targets.some((id) => queue.failures[id]?.red === false)) {
    const orangeTargets = queue.targets.filter((id) => queue.failures[id]?.red === false);
    const eligibleAt = Math.max(
      queue.orangeBackoffUntil,
      history.orangeLastAttemptAt ? history.orangeLastAttemptAt + settings.orangeGlobalSeconds * 1_000 : now,
    );
    for (const id of orangeTargets) {
      const last = history.bySession[id] ?? 0;
      const perSessionAt = last ? last + settings.perSessionSeconds * 1_000 : now;
      consider(Math.max(eligibleAt, perSessionAt), 10_000);
    }
  }
  for (const deadline of input.observationDeadlines) consider(deadline, 5_000);
  return Math.max(50, Math.min(delay, watchdogMs));
}
