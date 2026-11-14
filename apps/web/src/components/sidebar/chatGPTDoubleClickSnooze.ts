/** Double-click is an explicit 24-hour snooze, irrespective of the session's activity. */
export function chatGPTDoubleClickSnoozeUntil(now: number): number {
  return now + 24 * 60 * 60_000;
}
