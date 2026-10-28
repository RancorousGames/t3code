// @vitest-environment node
// @ts-expect-error jsdom's runtime types aren't installed in this workspace.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  beginRecoveryAttempt,
  finishRecoveryAttempt,
  manuallyRetryRecovery,
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
  it("keeps three targets stable while discoveries accumulate, then fills a recovered vacancy", () => {
    const start = reconcileRecoveryQueue("local", context(["a", "b", "c"]));
    expect(start.targets).toEqual(["a", "b", "c"]);
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"]));
    expect(readRecoveryQueue("local").targets).toEqual(["a", "b", "c"]);
    expect(Object.keys(readRecoveryQueue("local").failures)).toHaveLength(5);
    noteRecoveryVerified("local", "b");
    expect(readRecoveryQueue("local").targets).toEqual(["a", "c"]);
    reconcileRecoveryQueue("local", context(["a", "c", "d", "e"]));
    expect(readRecoveryQueue("local").targets).toEqual(["a", "c", "d"]);
    expect(readRecoveryQueue("local").history.some((event) => event.kind === "recovered")).toBe(
      true,
    );
  });

  it("lets selected failures and newly failing managers preempt existing targets", () => {
    reconcileRecoveryQueue("local", context(["a", "b", "c"]));
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d"], "d"));
    expect(readRecoveryQueue("local").targets).toContain("d");
    expect(readRecoveryQueue("local").targets).not.toContain("c");
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"], "d", ["e"]));
    expect(readRecoveryQueue("local").targets).toContain("e");
    expect(readRecoveryQueue("local").targets).toContain("d");
    expect(readRecoveryQueue("local").targets).toHaveLength(3);
  });

  it("gives older same-tier managers a fair turn, then rotates new manager into a slot", () => {
    reconcileRecoveryQueue("local", context(["a", "b", "c"], null, ["a", "b", "c"]));
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d"], null, ["a", "b", "c", "d"]));
    expect(readRecoveryQueue("local").targets).toEqual(["a", "b", "c"]);
    expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(1);
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d"], null, ["a", "b", "c", "d"]));
    expect(readRecoveryQueue("local").targets).toContain("d");
    const stable = readRecoveryQueue("local").targets;
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d"], null, ["a", "b", "c", "d"]));
    expect(readRecoveryQueue("local").targets).toEqual(stable);
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

  it("enforces manual > trusted manager > observed interruption > recent > ordinary", () => {
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"], null, ["b"], ["d"], ["c"]));
    manuallyRetryRecovery("local", "a");
    expect(recoveryPriorityOrder(readRecoveryQueue("local"))).toEqual(["a", "b", "c", "d", "e"]);
    expect(recoveryTargetOrder(readRecoveryQueue("local"))).toEqual(["a", "b", "c"]);
    // Selecting another broken guest preempts every other tier.
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"], "e", ["b"], ["d"], ["c"]));
    expect(recoveryPriorityOrder(readRecoveryQueue("local"))).toEqual(["e", "a", "b", "c", "d"]);
    expect(beginRecoveryAttempt("local", "a", "refresh")).toBe(1);
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"], "e", ["b"], ["d"], ["c"]));
    expect(recoveryPriorityOrder(readRecoveryQueue("local"))[0]).toBe("e");
  });

  it("rotates among ordinary failing sessions without starving queued peers", () => {
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"]));
    expect(readRecoveryQueue("local").targets).toEqual(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) expect(beginRecoveryAttempt("local", id, "refresh")).toBe(1);
    reconcileRecoveryQueue("local", context(["a", "b", "c", "d", "e"]));
    expect(readRecoveryQueue("local").targets.slice(0, 2)).toEqual(["d", "e"]);
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
