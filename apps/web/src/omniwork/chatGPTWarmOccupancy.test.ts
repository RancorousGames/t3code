import { describe, expect, it, vi } from "vite-plus/test";
import { hasVerifiedEmptyChatGPTComposer } from "../chatGPTDraftInspection";

import { plannedWarmChatGPTSessions, type WarmCandidate } from "./chatGPTWarmSessionPolicy";
import { snapshotWarmSessionOccupancy } from "./chatGPTWarmOccupancy";

const now = 10_000_000;
const rt = (environmentId: string, threadId: string, tab = "tab") =>
  JSON.stringify([environmentId, threadId, "epoch", tab]);
const key = (id: string) => JSON.stringify(["env", id]);
const session = (id: string, overrides: Partial<{
  mountEligible: boolean; hibernated: boolean; activity: "working" | "recent" | "inactive" | "invalid" | "unknown";
}> = {}) => ({ id, threadId: id, mountEligible: true, hibernated: false, activity: "unknown" as const, ...overrides });
const candidate = (id: string): WarmCandidate => ({
  id, manager: false, highlighted: false, hasChildren: false,
  recentlyClicked: -1, lastActiveAt: 0, recentlyUsedAt: 0,
});

describe("physical ChatGPT warm occupancy snapshot", () => {
  it("does not treat a nonempty or changing composer as safe to unload", async () => {
    const expectedUrl = "https://chatgpt.com/c/example";
    const guest = {
      executeJavaScript: vi.fn()
        .mockResolvedValueOnce({ status: "nonempty", url: expectedUrl, text: "unsent text" })
        .mockResolvedValueOnce({ status: "nonempty", url: expectedUrl, text: "unsent text" }),
    };
    expect(await hasVerifiedEmptyChatGPTComposer(guest, expectedUrl)).toBe(false);
    guest.executeJavaScript.mockReset()
      .mockResolvedValueOnce({ status: "empty", url: expectedUrl, text: "" })
      .mockResolvedValueOnce({ status: "nonempty", url: expectedUrl, text: "draft typed during probe" });
    expect(await hasVerifiedEmptyChatGPTComposer(guest, expectedUrl)).toBe(false);
  });
  it("does not count mount-eligible but unattached guests as residents", () => {
    const snapshot = snapshotWarmSessionOccupancy({
      environmentId: "env", now,
      sessions: [
        session("working", { activity: "working" }),
        session("idle", { activity: "inactive" }),
        session("broken", { activity: "invalid" }),
        session("pending"), session("stale"), session("eligible"),
        session("deferred", { mountEligible: false }),
        session("hibernated", { hibernated: true }),
      ],
      mountedRuntimeTabIds: [rt("env", "working"), rt("env", "idle"), rt("env", "broken"),
        rt("other-env", "eligible"), rt("env", "hibernated")],
      loadingAt: { [key("pending")]: now - 15_000, [key("stale")]: now - 130_000 },
    });
    expect([...snapshot.mountEligibleIds]).toHaveLength(6);
    expect([...snapshot.mountedIds].sort()).toEqual(["broken", "idle", "working"]);
    expect([...snapshot.verifiedLoadedIds].sort()).toEqual(["idle", "working"]);
    expect([...snapshot.pendingIds]).toEqual(["pending"]);
    expect([...snapshot.occupiedIds].sort()).toEqual(["broken", "idle", "pending", "working"]);
    const future = ["a", "b", "c", "d"].map(candidate);
    expect(plannedWarmChatGPTSessions({
      candidates: future, loadedIds: snapshot.occupiedIds,
      targetCount: 6, managersFirst: false, now,
    })).toEqual(["a", "b"]);
  });

  it.each([0, 2, 8, 32])("fills target N=%i only with real occupancy plus reservations", (targetCount) => {
    const candidates = Array.from({ length: 40 }, (_, i) => candidate(`candidate-${i}`));
    const results = plannedWarmChatGPTSessions({
      candidates,
      loadedIds: new Set(["already-mounted", "recent-pending"]),
      targetCount,
      managersFirst: false,
      now,
    });
    expect(results).toHaveLength(Math.max(0, targetCount - 2));
  });
  it("counts distinct sessions once across multiple mounted webviews and pending reservations", () => {
    const snapshot = snapshotWarmSessionOccupancy({
      environmentId: "env", now,
      sessions: [session("one", { activity: "working" }), session("two")],
      mountedRuntimeTabIds: [rt("env", "one", "tab1"), rt("env", "one", "tab2")],
      loadingAt: { [key("one")]: now - 20_000, [key("two")]: now - 20_000 },
    });
    expect([...snapshot.occupiedIds].sort()).toEqual(["one", "two"]);
    expect([...snapshot.pendingIds]).toEqual(["two"]);
  });

  it("excludes stale load reservations and sessions which were never attach eligible", () => {
    const snapshot = snapshotWarmSessionOccupancy({
      environmentId: "env", now,
      sessions: [session("old"), session("later", { mountEligible: false })],
      mountedRuntimeTabIds: [],
      loadingAt: { [key("old")]: now - 120_001, [key("later")]: now - 10_000 },
    });
    expect([...snapshot.occupiedIds]).toEqual([]);
  });
});
