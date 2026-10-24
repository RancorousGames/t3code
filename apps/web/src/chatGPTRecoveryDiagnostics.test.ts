import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  readChatGPTRecoveryEvents,
  readChatGPTRecoveryState,
  recordChatGPTRecoveryEvent,
} from "./chatGPTRecoveryDiagnostics";

const values = new Map<string, string>();
beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ChatGPT recovery diagnostics", () => {
  it("separates session histories and suppresses repeated scans within one minute", () => {
    recordChatGPTRecoveryEvent("env", "one", "failure-observed", "load-failure");
    recordChatGPTRecoveryEvent("env", "two", "phase", "checking");
    recordChatGPTRecoveryEvent("env", "one", "failure-observed", "load-failure");
    expect(readChatGPTRecoveryEvents("env", "one")).toHaveLength(1);
    expect(readChatGPTRecoveryEvents("env", "two")).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    recordChatGPTRecoveryEvent("env", "one", "failure-observed", "load-failure");
    expect(readChatGPTRecoveryEvents("env", "one")).toHaveLength(2);
  });

  it("reports retry state but ignores obsolete terminal escalation", () => {
    values.set(
      "t3code:chatgpt-browser:bounded-recovery:env",
      JSON.stringify({
        red: { one: { attempts: 3, nextAt: 1792535000000 } },
        orange: {},
        escalation: { one: { reason: "guest_url_or_health_unverifiable" } },
      }),
    );
    values.set(
      "t3code:chatgpt-browser:recovery:env",
      JSON.stringify({
        bySession: { one: 1792534500000 },
        lastAttemptAt: 1792534500000,
      }),
    );
    expect(readChatGPTRecoveryState("env", "one")).toMatchObject({
      lastAttemptAt: 1792534500000,
      retryCount: 3,
      nextRetryAt: 1792534620000,
      escalationReason: null,
    });
    expect(readChatGPTRecoveryState("env", "other").retryCount).toBe(0);
  });

  it("caps stored data and does not allow storage failure to break recovery", () => {
    for (let i = 0; i < 300; i++) {
      recordChatGPTRecoveryEvent("env", "one", "phase", String(i));
    }
    const all = JSON.parse([...values.values()][0]!) as unknown[];
    expect(all).toHaveLength(250);
    expect(readChatGPTRecoveryEvents("env", "one", 50)).toHaveLength(50);
    values.clear();
    values.set("t3code:chatgpt-browser:recovery-log:env", "{invalid");
    expect(readChatGPTRecoveryEvents("env", "one")).toEqual([]);
    expect(() => recordChatGPTRecoveryEvent("env", "one", "phase")).not.toThrow();
  });
});
