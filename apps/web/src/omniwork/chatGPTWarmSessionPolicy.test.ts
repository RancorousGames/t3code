import { beforeEach, describe, expect, it } from "vite-plus/test";

import { makeChatGPTStartupLoadPlan, shouldLoadChatGPTSession } from "./chatGPTStartupLoadPolicy";
import {
  activateWarmChatGPTSession, finishWarmChatGPTSessionLoad,
  plannedWarmChatGPTSessions, nextWarmChatGPTSession, warmLoadingKey,
  useChatGPTWarmSessions, type WarmCandidate,
} from "./chatGPTWarmSessionPolicy";

const now = Date.now();
const candidate = (id: string, overrides: Partial<WarmCandidate> = {}): WarmCandidate => ({
  id, manager: false, highlighted: false, selected: false,
  activeBeforeFailure: false, recentlyClicked: -1,
  lastActiveAt: 0, lastActivityAt: 0, createdAt: 0,
  ...overrides,
});
const selection = (candidates: WarmCandidate[], loaded: string[] = [], count = 8) =>
  ({ candidates, loadedIds: new Set(loaded), targetCount: count, now });

beforeEach(() => useChatGPTWarmSessions.setState({ byEnvironment: {}, loadingAt: {}, forecast: {} }));

describe("stable warm ChatGPT working set", () => {
  it("implements all eight tiers in the exact requested order", () => {
    const candidates = [
      candidate("created", { createdAt: now }),
      candidate("prior-activity", { lastActivityAt: now - 10 * 60 * 60_000 }),
      candidate("manager", { manager: true }),
      candidate("recent-activity", { lastActiveAt: now - 20_000, lastActivityAt: now - 20_000 }),
      candidate("border", { highlighted: true }),
      candidate("click", { recentlyClicked: 0 }),
      candidate("green-before-error", { activeBeforeFailure: true }),
      candidate("selected", { selected: true }),
    ];
    expect(plannedWarmChatGPTSessions(selection(candidates))).toEqual([
      "selected", "green-before-error", "click", "border",
      "recent-activity", "manager", "prior-activity", "created",
    ]);
  });

  it("ranks pending delivery immediately below the selected tab and may exceed warm capacity", () => {
    const all = [candidate("active", { activeBeforeFailure: true }),
      candidate("delivery", { deliveryPending: true, exceedTarget: true }),
      candidate("selected", { selected: true })];
    expect(plannedWarmChatGPTSessions(selection(all))).toEqual(["selected", "delivery", "active"]);
    expect(nextWarmChatGPTSession(selection(all, ["selected"], 1))).toBe("delivery");
  });

  it("selects only the three clicked ranks, most recent first; older clicks fall back", () => {
    expect(plannedWarmChatGPTSessions(selection([
      candidate("third", { recentlyClicked: 2, createdAt: 100 }),
      candidate("outdated", { recentlyClicked: -1, createdAt: 500 }),
      candidate("second", { recentlyClicked: 1 }),
      candidate("first", { recentlyClicked: 0 }),
    ]))).toEqual(["first", "second", "third", "outdated"]);
  });

  it("prioritizes recently working sessions above managers and old user clicks", () => {
    expect(nextWarmChatGPTSession(selection([
      candidate("manager", { manager: true, lastActivityAt: now - 400_000_000 }),
      candidate("old-click", { lastActivityAt: now - 5 * 60 * 60_000 }),
      candidate("recent-worker", { lastActiveAt: now - 20_000, lastActivityAt: now - 20_000 }),
    ]))).toBe("recent-worker");
  });

  it("uses activity time, then actual creation time, then ID to break ties", () => {
    expect(plannedWarmChatGPTSessions(selection([
      candidate("older", { lastActivityAt: 100, createdAt: 1 }),
      candidate("newer", { lastActivityAt: 100, createdAt: 2 }),
      candidate("more-active", { lastActivityAt: 101 }),
    ]))).toEqual(["more-active", "newer", "older"]);
    expect(plannedWarmChatGPTSessions(selection([
      candidate("old", { createdAt: 10 }),
      candidate("latest", { createdAt: 100 }),
      candidate("legacy"),
    ]))).toEqual(["latest", "old", "legacy"]);
  });

  it("never evicts a loaded guest just because a higher-priority candidate appears", () => {
    const candidates = [candidate("selected", { selected: true }), candidate("other")];
    expect(nextWarmChatGPTSession(selection(candidates, ["other"], 1))).toBeNull();
    expect(nextWarmChatGPTSession(selection(candidates, ["other"], 2))).toBe("selected");
    expect(nextWarmChatGPTSession(selection(candidates, ["other"], 0))).toBeNull();
  });

  it("still respects explicitly approved capacity exceptions", () => {
    const input = selection([
      candidate("ordinary"),
      candidate("manager", { manager: true, exceedTarget: true }),
      candidate("working", { lastActiveAt: now - 60_000, lastActivityAt: now - 60_000, exceedTarget: true }),
    ], ["loaded-a", "loaded-b"], 2);
    expect(nextWarmChatGPTSession(input)).toBe("working");
    expect(nextWarmChatGPTSession({ ...input, loadedIds: new Set(["loaded-a", "loaded-b", "working"]) })).toBe("manager");
  });

  it("retains warm residency and supports retry after a timed-out mount", () => {
    const plan = makeChatGPTStartupLoadPlan(["manager", "worker"], false);
    expect(shouldLoadChatGPTSession(plan, "manager", null)).toBe(false);
    activateWarmChatGPTSession("test-env", plan, "manager");
    expect(shouldLoadChatGPTSession(plan, "manager", null)).toBe(true);
    expect(shouldLoadChatGPTSession(plan, "worker", null)).toBe(false);
    expect(useChatGPTWarmSessions.getState().byEnvironment["test-env"]).toEqual(["manager"]);
    finishWarmChatGPTSessionLoad("test-env", "manager");
    activateWarmChatGPTSession("test-env", plan, "manager");
    expect(useChatGPTWarmSessions.getState().byEnvironment["test-env"]).toEqual(["manager"]);
    expect(useChatGPTWarmSessions.getState().loadingAt[warmLoadingKey("test-env", "manager")]).toBeGreaterThan(0);
  });

  it("shows only remaining slots, not every dormant session, in the load forecast", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(String(index)));
    expect(plannedWarmChatGPTSessions(selection(candidates, ["already-open"], 3))).toHaveLength(2);
    expect(plannedWarmChatGPTSessions(selection(candidates, ["already-open"], 0))).toEqual([]);
  });
});
