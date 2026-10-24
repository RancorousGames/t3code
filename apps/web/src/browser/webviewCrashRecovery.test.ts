import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
  planWebviewCrashRecovery,
  WEBVIEW_CRASH_RECOVERY_WINDOW_MS,
} from "./webviewCrashRecovery";

describe("planWebviewCrashRecovery", () => {
  it("retries crash recovery indefinitely at fixed delays without a storm", () => {
    let state = INITIAL_WEBVIEW_CRASH_RECOVERY_STATE;
    for (let attempt = 1; attempt <= 50; attempt++) {
      const plan = planWebviewCrashRecovery(state, 1_000 + attempt * 100)!;
      expect(plan.delayMs).toBe(attempt <= 3 ? 250 : 120_000);
      state = plan.state;
    }
    expect(state.attempts).toBe(50);
  });

  it("allows recovery again after the crash window expires", () => {
    const first = planWebviewCrashRecovery(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE, 1_000)!;
    const second = planWebviewCrashRecovery(first.state, 1_100)!;
    const third = planWebviewCrashRecovery(second.state, 1_200)!;

    expect(planWebviewCrashRecovery(third.state, 1_000 + WEBVIEW_CRASH_RECOVERY_WINDOW_MS)).toEqual(
      {
        delayMs: 250,
        state: {
          attempts: 1,
          windowStartedAt: 1_000 + WEBVIEW_CRASH_RECOVERY_WINDOW_MS,
        },
      },
    );
  });
});
