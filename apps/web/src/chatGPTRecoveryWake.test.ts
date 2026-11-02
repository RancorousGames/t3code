import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CHATGPT_RECOVERY_SETTINGS } from "./chatGPTRecoverySettings";
import { recoveryNextWakeDelayMs } from "./chatGPTRecoveryWake";
import type { RecoveryQueueState } from "./components/sidebar/chatGPTRecoveryQueue";
import type { RecoveryHistory } from "./components/sidebar/chatGPTConversationRecovery";

const settings = { ...DEFAULT_CHATGPT_RECOVERY_SETTINGS, watchdogSeconds: 180 };
const now = 1_000_000;
const history: RecoveryHistory = {
  lastAttemptAt: 0, redLastAttemptAt: 0, orangeLastAttemptAt: 0, bySession: {},
};
const queue: RecoveryQueueState = {
  targets: [], activeRedId: null, failures: {}, history: [], failureStreak: 0,
  backoffUntil: 0, redFailureStreak: 0, orangeFailureStreak: 0,
  redBackoffUntil: 0, orangeBackoffUntil: 0,
};
const input = (patch: Partial<Parameters<typeof recoveryNextWakeDelayMs>[0]> = {}) => ({
  now, settings, queue, history, observationDeadlines: [], ...patch,
});

describe("event-driven recovery wake deadlines", () => {
  it("leaves healthy sessions alone until the fallback watchdog", () => {
    expect(recoveryNextWakeDelayMs(input())).toBe(180_000);
  });

  it("wakes the pinned red session exactly at global retry spacing, not at the watchdog", () => {
    const red = { ...queue, targets: ["red"], activeRedId: "red" };
    expect(recoveryNextWakeDelayMs(input({
      queue: red, history: { ...history, redLastAttemptAt: now - 18_000 },
    }))).toBe(12_000);
    expect(recoveryNextWakeDelayMs(input({
      queue: red, history: { ...history, redLastAttemptAt: now - 45_000 },
    }))).toBe(5_000);
  });

  it("honors lane-specific 10-minute backoff without blocking orange deadlines", () => {
    const red = { ...queue, targets: ["red"], activeRedId: "red",
      redBackoffUntil: now + 600_000,
    };
    expect(recoveryNextWakeDelayMs(input({ queue: red }))).toBe(180_000);
    const mixed = { ...red, targets: ["red", "orange"], failures: {
      orange: { red: false },
    } as unknown as RecoveryQueueState["failures"] };
    expect(recoveryNextWakeDelayMs(input({
      queue: mixed, history: { ...history, orangeLastAttemptAt: now - 45_000 },
    }))).toBe(15_000);
  });

  it("wakes at orange grace and guest hydration deadlines", () => {
    expect(recoveryNextWakeDelayMs(input({
      observationDeadlines: [now + 600_000, now + 7_000],
    }))).toBe(7_000);
    expect(recoveryNextWakeDelayMs(input({
      observationDeadlines: [now - 1_000],
    }))).toBe(5_000);
  });

  it("honors orange per-session cooldown independently of global cadence", () => {
    const orange = { ...queue, targets: ["orange"], failures: {
      orange: { red: false },
    } as unknown as RecoveryQueueState["failures"] };
    expect(recoveryNextWakeDelayMs(input({
      queue: orange,
      history: { ...history, orangeLastAttemptAt: now - 58_000,
        bySession: { orange: now - 100_000 } },
    }))).toBe(20_000);
  });
});
