// @vitest-environment node
// @ts-expect-error jsdom's runtime types aren't installed in this workspace.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readChatGPTRecoveryAttemptLog } from "../../chatGPTRecoveryAttemptLog";
import {
  beginRecoveryAttempt,
  finishRecoveryAttempt,
  manuallyRetryRecovery,
  noteRecoveryFailure,
  noteRecoveryVerified,
  readRecoveryQueue,
  reconcileRecoveryQueue,
  recoveryPriorityOrder,
  recoveryTargetOrder,
} from "./chatGPTRecoveryQueue";

let dom: JSDOM;
const context = (
  failingIds: string[],
  selectedId: string | null = null,
  managerIds: string[] = [],
  recentClicks: string[] = [],
  interruptedIds: string[] = [],
) => ({
  eligibleIds: ["a", "b", "c", "d", "e"],
  failingIds,
  selectedId,
  managerIds,
  recentClicks,
  interruptedIds,
  lastActive: { a: 100, b: 90, c: 80, d: 70, e: 60 },
});
beforeEach(() => {
  dom = new JSDOM("", { url: "https://localhost/" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("sessionStorage", dom.window.sessionStorage);
  vi.stubGlobal("CustomEvent", dom.window.CustomEvent);
});
afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});
describe("persistent three-target recovery queue", () => {

  it("pins the first red target despite additional failures, promoting only after verified health", () => {
    const start = reconcileRecoveryQueue("local", context(["a", "b", "c"]));
    expect(start.targets).toEqual(["a"]);
    expect(start.activeRedId).toBe("a");
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"]));
    expect(readRecoveryQueue("local").targets).toEqual(["a"]);
    expect(readRecoveryQueue("local").activeRedId).toBe("a");
    noteRecoveryVerified("local", "a");
    reconcileRecoveryQueue("local", context(["b", "c", "d", "e"]));
    expect(readRecoveryQueue("local").activeRedId).toBe("b");
    expect(readRecoveryQueue("local").targets).toEqual(["b"]);
  });

  it("does not let three orange targets consume the red recovery slots", () => {
    for (const id of ["a", "b", "c"])
      noteRecoveryFailure("local", id, "interrupted", context([]));
    expect(readRecoveryQueue("local").targets).toEqual(["a", "b", "c"]);
    const next = reconcileRecoveryQueue("local", context(["d"]));
    expect(next.targets[0]).toBe("d");
    expect(next.failures.d?.red).toBe(true);
    expect(next.targets.filter((id) => id !== "d")).toHaveLength(2);
  });


  it("selection and new managers cannot displace a pinned red failure; explicit manual override can", () => {
    reconcileRecoveryQueue("local", context(["a", "b", "c"]));
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d"], "d", ["d"]));
    expect(readRecoveryQueue("local").targets).toEqual(["a"]);
    expect(beginRecoveryAttempt("local", "d", "refresh")).toBeNull();
    manuallyRetryRecovery("local", "d");
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d"], "d", ["d"]));
    expect(readRecoveryQueue("local").activeRedId).toBe("d");
    expect(readRecoveryQueue("local").targets).toEqual(["d"]);
    expect(beginRecoveryAttempt("local", "a", "refresh")).toBeNull();
    expect(beginRecoveryAttempt("local", "d", "refresh")).toBe(1);
  });


  it("does not rotate among equally prioritized red managers after repeated attempts", () => {
    reconcileRecoveryQueue("local", context(["a", "b", "c"], null, ["a", "b", "c"]));
    for (let n = 1; n <= 51; n++) {
      expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(n);
      reconcileRecoveryQueue("local", context(["a", "b", "c", "d"], null, ["a", "b", "c", "d"]));
      expect(readRecoveryQueue("local").activeRedId).toBe("a");
      expect(readRecoveryQueue("local").targets).toEqual(["a"]);
      expect(beginRecoveryAttempt("local", "b", "refresh")).toBeNull();
    }
    noteRecoveryVerified("local", "a");
    reconcileRecoveryQueue("local", context(["b", "c", "d"], null, ["b", "c", "d"]));
    expect(readRecoveryQueue("local").activeRedId).toBe("b");
  });

  it("records indefinite attempts 1, 50, 51 and 100, without terminal exhaustion", () => {
    reconcileRecoveryQueue("local", context(["a"]));
    for (let n = 1; n <= 100; n++) {
      expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(n);
      finishRecoveryAttempt("local", "a", "refresh timed out");
      if ([1, 50, 51, 100].includes(n)) {
        const state = readRecoveryQueue("local");
        expect(state.failures.a?.attempts).toBe(n);
        expect(state.failures.a?.exhausted).toBe(false);
        expect(state.targets).toContain("a");
      }
    }
    const state = readRecoveryQueue("local");
    expect(state.history.filter((event) => event.kind === "attempt")).toHaveLength(100);
    expect(state.history.some((event) => event.kind === "exhausted")).toBe(false);
    expect(state.history.find((event) => event.kind === "attempt")?.detail).toContain("priority:");
    expect(state.history.find((event) => event.kind === "outcome")?.detail).toContain("timed out");
    manuallyRetryRecovery("local", "a");
    expect(readRecoveryQueue("local").failures.a?.attempts).toBe(100);
    expect(readRecoveryQueue("local").targets).toEqual(["a"]);
    expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(101);
  });

  it("pauses all recovery targets after 20 observed failures, then retries after ten minutes", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
      reconcileRecoveryQueue("local", context(["a", "b"]));
      for (let n = 1; n <= 20; n++) {
        expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(n);
        finishRecoveryAttempt("local", "a", "refresh finished; health pending");
        noteRecoveryFailure("local", "a", "load-failure", context(["a", "b"]));
      }
      const state = readRecoveryQueue("local");
      expect(state.failureStreak).toBe(0);
      expect(state.backoffUntil).toBe(Date.now() + 600_000);
      expect(state.history.filter((event) => event.kind === "backoff")).toHaveLength(1);
      const durable = readChatGPTRecoveryAttemptLog("local");
      expect(durable.filter((event) => event.kind === "attempt")).toHaveLength(20);
      expect(durable.at(-1)).toMatchObject({ kind: "backoff", pauseUntil: Date.now() + 600_000 });
      sessionStorage.clear();
      expect(readChatGPTRecoveryAttemptLog("local")).toHaveLength(21);
      sessionStorage.setItem("t3code:chatgpt-browser:recovery-queue:local", JSON.stringify(state));
      expect(beginRecoveryAttempt("local", "a", "refresh")).toBeNull();
      expect(beginRecoveryAttempt("local", "b", "refresh")).toBeNull();
      manuallyRetryRecovery("local", "a");
      vi.advanceTimersByTime(599_999);
      expect(beginRecoveryAttempt("local", "a", "refresh")).toBeNull();
      vi.advanceTimersByTime(1);
      expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(21);
    } finally {
      vi.useRealTimers();
    }
  });

  it("orange's 10-minute failure pause never blocks a red retry", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-29T10:00:00Z"));
      reconcileRecoveryQueue("local", context(["b"])); // b is red
      noteRecoveryFailure("local", "a", "interrupted", context(["b"])); // a is orange
      for (let n = 1; n <= 20; n++) {
        expect(beginRecoveryAttempt("local", "a", "refresh:interrupted")).toBe(n);
        finishRecoveryAttempt("local", "a", "refresh finished; health pending");
        noteRecoveryFailure("local", "a", "interrupted", context(["b"]));
      }
      const queued = readRecoveryQueue("local");
      expect(queued.orangeBackoffUntil).toBe(Date.now() + 600_000);
      expect(queued.redBackoffUntil).toBe(0);
      expect(beginRecoveryAttempt("local", "a", "refresh:interrupted")).toBeNull();
      expect(beginRecoveryAttempt("local", "b", "refresh:load-failure")).toBe(1);
      expect(readRecoveryQueue("local").history.at(-1)?.kind).toBe("attempt");
    } finally {
      vi.useRealTimers();
    }
  });

  it("only counts observed failures and resets the streak on verified recovery", () => {
    reconcileRecoveryQueue("local", context(["a", "b"]));
    beginRecoveryAttempt("local", "a", "refresh");
    finishRecoveryAttempt("local", "a", "refresh finished; health pending");
    expect(readRecoveryQueue("local").failureStreak).toBe(0);
    noteRecoveryFailure("local", "a", "load-failure", context(["a", "b"]));
    noteRecoveryFailure("local", "a", "load-failure", context(["a", "b"]));
    expect(readRecoveryQueue("local").failureStreak).toBe(1);
    noteRecoveryVerified("local", "a");
    expect(readRecoveryQueue("local").failureStreak).toBe(0);
  });

  it("restores legacy exhausted episodes without discarding their retry history", () => {
    reconcileRecoveryQueue("local", context(["a"]));
    const raw = readRecoveryQueue("local");
    raw.failures.a!.attempts = 50;
    raw.failures.a!.exhausted = true;
    raw.targets = [];
    sessionStorage.setItem("t3code:chatgpt-browser:recovery-queue:local", JSON.stringify(raw));
    expect(readRecoveryQueue("local").failures.a?.exhausted).toBe(false);
    reconcileRecoveryQueue("local", context(["a"]));
    expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(51);
  });


  it("manual red priority takes the pin and retains it after the override is consumed", () => {
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"], null, ["b"]));
    expect(readRecoveryQueue("local").activeRedId).toBe("b");
    manuallyRetryRecovery("local", "a");
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"], "e", ["b"]));
    expect(recoveryPriorityOrder(readRecoveryQueue("local"))[0]).toBe("a");
    expect(recoveryTargetOrder(readRecoveryQueue("local"))).toEqual(["a"]);
    expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(1);
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"], "e", ["b"]));
    expect(readRecoveryQueue("local").activeRedId).toBe("a");
    expect(beginRecoveryAttempt("local", "e", "refresh")).toBeNull();
  });


  it("retries the same selected red session indefinitely while other red sessions wait", () => {
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"], "a", ["a", "b", "c", "d"]));
    for (let n = 1; n <= 100; n++) {
      expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(n);
      reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"], "a", ["a", "b", "c", "d"]));
      expect(readRecoveryQueue("local").targets).toEqual(["a"]);
      expect(beginRecoveryAttempt("local", "b", "refresh")).toBeNull();
    }
    expect(readRecoveryQueue("local").failures.a?.exhausted).toBe(false);
  });


  it("keeps the pinned red target reserved while its browser action is unresolved, allowing orange work", () => {
    reconcileRecoveryQueue("local", context(["a", "b", "c"]));
    for (const id of ["d", "e"])
      noteRecoveryFailure("local", id, "interrupted", context(["a", "b", "c"]));
    reconcileRecoveryQueue("local", {
      ...context(["a", "b", "c"]), suspendedIds: ["a"],
    });
    expect(readRecoveryQueue("local").activeRedId).toBe("a");
    expect(readRecoveryQueue("local").targets).toEqual(["d", "e"]);
    expect(beginRecoveryAttempt("local", "b", "refresh")).toBeNull();
    reconcileRecoveryQueue("local", context(["a", "b", "c"]));
    expect(readRecoveryQueue("local").targets).toEqual(["a", "d", "e"]);
  });


  it("prioritizes orange manual, manager, interrupted work and recent clicks before older ordinary retries", () => {
    // No red failures: these are all confirmed orange incidents.
    for (const id of ["a", "b", "c", "d", "e"])
      noteRecoveryFailure("local", id, "interrupted", context([]));
    const prioritized = context([], null, ["b"], ["d"], ["c"]);
    reconcileRecoveryQueue("local", prioritized);
    expect(recoveryPriorityOrder(readRecoveryQueue("local"))).toEqual(["b", "c", "d", "a", "e"]);
    // Merely selecting a lower-tier guest must not displace trusted work.
    reconcileRecoveryQueue("local", { ...prioritized, selectedId: "a" });
    expect(recoveryPriorityOrder(readRecoveryQueue("local"))).toEqual(["b", "c", "a", "d", "e"]);
    // A manual retry outranks every automatic tier even after another guest was tried earlier.
    manuallyRetryRecovery("local", "e");
    reconcileRecoveryQueue("local", prioritized);
    expect(recoveryPriorityOrder(readRecoveryQueue("local"))[0]).toBe("e");
  });

  it("rotates orange guests by oldest attempt only within the same priority tier", () => {
    for (const id of ["a", "b", "c", "d"])
      noteRecoveryFailure("local", id, "interrupted", context([]));
    const prioritized = context([], null, ["a", "b"]);
    reconcileRecoveryQueue("local", prioritized);
    expect(recoveryTargetOrder(readRecoveryQueue("local"))).toEqual(["a", "b", "c"]);
    expect(beginRecoveryAttempt("local", "a", "orange")).toBe(1);
    reconcileRecoveryQueue("local", prioritized);
    expect(recoveryPriorityOrder(readRecoveryQueue("local"))).toEqual(["b", "a", "c", "d"]);
    // Manager priority remains above untried ordinary guests even when attempts rotate.
    expect(readRecoveryQueue("local").targets.slice(0, 2)).toEqual(["b", "a"]);
  });

  it("round-robins orange failures while keeping red recovery pinned", () => {
    reconcileRecoveryQueue("local", context(["a"]));
    for (const id of ["b", "c", "d", "e"])
      noteRecoveryFailure("local", id, "interrupted", context(["a"]));
    expect(readRecoveryQueue("local").targets).toEqual(["a", "b", "c"]);
    expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(1);
    expect(beginRecoveryAttempt("local", "b", "orange")).toBe(1);
    expect(beginRecoveryAttempt("local", "c", "orange")).toBe(1);
    reconcileRecoveryQueue("local", context(["a"]));
    expect(readRecoveryQueue("local").targets).toEqual(["a", "d", "e"]);
    expect(readRecoveryQueue("local").activeRedId).toBe("a");
    expect(beginRecoveryAttempt("local", "b", "orange")).toBeNull();
    expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(2);
  });

  it("persists across a coordinator remount but resets with the T3 window session", () => {
    reconcileRecoveryQueue("local", context(["a"]));
    beginRecoveryAttempt("local", "a", "refresh");
    expect(readRecoveryQueue("local").failures.a?.attempts).toBe(1);
    // Read again as if a different React component mounted in the same window.
    expect(readRecoveryQueue("local").history.some((event) => event.kind === "attempt")).toBe(true);
    sessionStorage.clear(); // A new Electron window/app session starts with fresh sessionStorage.
    expect(readRecoveryQueue("local").targets).toEqual([]);
    expect(readRecoveryQueue("local").history).toEqual([]);
  });

  it("never targets snoozed or closed sessions excluded from the eligible set", () => {
    reconcileRecoveryQueue("local", context(["a", "b", "c"]));
    reconcileRecoveryQueue("local", {
      ...context(["a", "b", "c"]),
      eligibleIds: ["b", "c"],
    });
    expect(readRecoveryQueue("local").targets).not.toContain("a");
    expect(readRecoveryQueue("local").failures.a).toBeUndefined();
  });
});
