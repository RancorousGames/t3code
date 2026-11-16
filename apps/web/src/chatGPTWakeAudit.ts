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
  const bridge = window.desktopBridge?.stableChatGPTViewRequest;
  if (!bridge) return;
  const detail = [
    `reason=${reason}`,
    `previousUntil=${options.previousUntil ?? "none"}`,
    `nextUntil=${options.nextUntil ?? "none"}`,
    `snoozedAt=${options.snoozedAt ?? "none"}`,
    `quickStep=${options.quickSnoozeStep ?? "none"}`,
    `now=${Date.now()}`,
  ].join(" ");
  // The native owner writes this to a rotated NDJSON log. Never block a wake,
  // snooze, or session-rendering path if the bridge is unavailable.
  try {
    void Promise.resolve(
      bridge({
        operation: "recovery_event",
        identity: { environmentId, sessionId, profileId: options.profileId ?? "default" },
        kind: "wake",
        detail: detail.slice(0, 220),
      }),
    ).catch(() => {});
  } catch {
    /* Telemetry must not affect session behavior. */
  }
}
