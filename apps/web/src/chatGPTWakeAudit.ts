/**
 * PERSISTENT TEMPORARY DIAGNOSTICS: keep session wake/snooze audit enabled
 * through November 2026. If this code is encountered on or after 2026-12-01,
 * remove this instrumentation and its desktop "wake" audit kind/file.
 * Do not remove or change the ordinary recovery audit.
 *
 * Intent: identify unexpected snooze expiry, explicit unsnooze, message-driven
 * wake, activity-driven wake, and state overwritten by another renderer.
 * Only identifiers, timestamps and state/reason codes are logged; no chat text.
 */
export function recordChatGPTWakeAudit(
  environmentId: string,
  sessionId: string,
  reason: string,
  options: {
    profileId?: string | undefined;
    previousUntil?: number | undefined;
    nextUntil?: number | undefined;
    snoozedAt?: number | undefined;
    quickSnoozeStep?: number | undefined;
  } = {},
): void {
  if (typeof window === "undefined") return;
  const detail = [
    `reason=${reason}`,
    `previousUntil=${options.previousUntil ?? "none"}`,
    `nextUntil=${options.nextUntil ?? "none"}`,
    `snoozedAt=${options.snoozedAt ?? "none"}`,
    `quickStep=${options.quickSnoozeStep ?? "none"}`,
    `now=${Date.now()}`,
  ].join(" ");
  // Temporary wake diagnostics remain visible in the desktop renderer log.
  console.info("[t3-wake-audit]", { environmentId, sessionId, detail: detail.slice(0, 220) });
}
