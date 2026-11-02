import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  readChatGPTRecoveryEvents,
  readChatGPTRecoveryState,
  recordChatGPTRecoveryEvent,
} from "./chatGPTRecoveryDiagnostics";

const values = new Map<string, string>();
let environmentId = "";
let sequence = 0;
beforeEach(() => {
  environmentId = "diagnostics-env-" + ++sequence;
  values.clear();
  const storage = {
    get length() { return values.size; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage, sessionStorage: storage, dispatchEvent: () => true });
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
    recordChatGPTRecoveryEvent(environmentId, "one", "failure-observed", "load-failure");
    recordChatGPTRecoveryEvent(environmentId, "two", "phase", "checking");
    recordChatGPTRecoveryEvent(environmentId, "one", "failure-observed", "load-failure");
    expect(readChatGPTRecoveryEvents(environmentId, "one")).toHaveLength(1);
    expect(readChatGPTRecoveryEvents(environmentId, "two")).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    recordChatGPTRecoveryEvent(environmentId, "one", "failure-observed", "load-failure");
    expect(readChatGPTRecoveryEvents(environmentId, "one")).toHaveLength(2);
  });

  it("reports retry state but ignores obsolete terminal escalation", () => {
    values.set(
      `t3code:chatgpt-browser:bounded-recovery:${environmentId}`,
      JSON.stringify({
        red: { one: { attempts: 3, nextAt: 1792535000000 } },
        orange: {},
        escalation: { one: { reason: "guest_url_or_health_unverifiable" } },
      }),
    );
    values.set(
      `t3code:chatgpt-browser:recovery:${environmentId}`,
      JSON.stringify({
        bySession: { one: 1792534500000 },
        lastAttemptAt: 1792534500000,
      }),
    );
    expect(readChatGPTRecoveryState(environmentId, "one")).toMatchObject({
      lastAttemptAt: 1792534500000,
      retryCount: 3,
      nextRetryAt: null,
      escalationReason: null,
    });
    expect(readChatGPTRecoveryState(environmentId, "other").retryCount).toBe(0);
  });

  it("caps stored data and does not allow storage failure to break recovery", () => {
    for (let i = 0; i < 300; i++) {
      recordChatGPTRecoveryEvent(environmentId, "one", "phase", String(i));
    }
    const all = JSON.parse(values.get(`t3code:chatgpt-browser:recovery-log:${environmentId}`)!) as unknown[];
    expect(all).toHaveLength(250);
    expect(readChatGPTRecoveryEvents(environmentId, "one", 50)).toHaveLength(50);
    values.clear();
    values.set(`t3code:chatgpt-browser:recovery-log:${environmentId}`, "{invalid");
    // The migrated Zustand store remains authoritative even when an old
    // legacy diagnostic key is subsequently corrupted.
    expect(readChatGPTRecoveryEvents(environmentId, "one")).toHaveLength(20);
    expect(() => recordChatGPTRecoveryEvent(environmentId, "one", "phase")).not.toThrow();
  });
});
