export const WEBVIEW_CRASH_RECOVERY_WINDOW_MS = 30_000;
const WEBVIEW_CRASH_RECOVERY_FAST_ATTEMPTS = 3;
const WEBVIEW_CRASH_RECOVERY_FAST_DELAY_MS = 250;
const WEBVIEW_CRASH_RECOVERY_PATIENT_DELAY_MS = 2 * 60_000;

export interface WebviewCrashRecoveryState {
  readonly attempts: number;
  readonly windowStartedAt: number | null;
}

export interface WebviewCrashRecoveryPlan {
  readonly delayMs: number;
  readonly state: WebviewCrashRecoveryState;
}

export const INITIAL_WEBVIEW_CRASH_RECOVERY_STATE: WebviewCrashRecoveryState = {
  attempts: 0,
  windowStartedAt: null,
};

export function planWebviewCrashRecovery(
  state: WebviewCrashRecoveryState,
  now: number,
): WebviewCrashRecoveryPlan | null {
  const startsNewWindow =
    state.windowStartedAt === null ||
    now - state.windowStartedAt >= WEBVIEW_CRASH_RECOVERY_WINDOW_MS;
  const attempts = startsNewWindow ? 0 : state.attempts;

  const nextAttempts = attempts + 1;
  return {
    // Never abandon a crashed guest. Limit rapid crash storms without
    // escalating or increasing the delay with each subsequent attempt.
    delayMs:
      attempts < WEBVIEW_CRASH_RECOVERY_FAST_ATTEMPTS
        ? WEBVIEW_CRASH_RECOVERY_FAST_DELAY_MS
        : WEBVIEW_CRASH_RECOVERY_PATIENT_DELAY_MS,
    state: {
      attempts: nextAttempts,
      windowStartedAt: startsNewWindow ? now : state.windowStartedAt,
    },
  };
}
