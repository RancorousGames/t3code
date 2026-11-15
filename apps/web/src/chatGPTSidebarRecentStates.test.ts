import { describe, expect, it } from "vite-plus/test";
import {
  chatGPTActivityColorClass,
  hideChatGPTSessionAsUnloaded,
  unloadedChatGPTActivityAge,
  CHATGPT_RECENT_ACTIVITY_MS,
} from "./components/sidebar/chatGPTActivity";
import { layoutChatGPTSessions } from "./chatGPTSessionGrouping";
import { FRESH_MANUAL_PRIORITY_MAX_AGE_MS, freshManualSessionIds, prioritizeFreshManualSession } from "./chatGPTFreshManualSession";

describe("sidebar unloaded recency", () => {
  const now = 100_000_000;
  it("keeps a recent unloaded session dark blue and a previously working unloaded session dark green", () => {
    expect(unloadedChatGPTActivityAge(now - 1000, false, now)).toBe("unloaded-recent");
    expect(unloadedChatGPTActivityAge(now - 1000, true, now)).toBe("unloaded-working");
    expect(chatGPTActivityColorClass("unloaded-recent")).not.toBe(
      chatGPTActivityColorClass("recent"),
    );
    expect(chatGPTActivityColorClass("unloaded-working")).not.toBe(
      chatGPTActivityColorClass("working"),
    );
    expect(unloadedChatGPTActivityAge(now - CHATGPT_RECENT_ACTIVITY_MS, true, now)).toBe(
      "unloaded",
    );
    expect(unloadedChatGPTActivityAge(now - CHATGPT_RECENT_ACTIVITY_MS, false, now)).toBe(
      "unloaded",
    );
  });

  it("Hide Unloaded hides every unloaded residency regardless of recent work", () => {
    for (const status of ["unloaded", "unloaded-working", "unloaded-recent"] as const) {
      expect(hideChatGPTSessionAsUnloaded(status, true)).toBe(true);
      expect(hideChatGPTSessionAsUnloaded(status, false)).toBe(false);
    }
    for (const status of ["recent", "working", "inactive", "unknown"] as const) {
      expect(hideChatGPTSessionAsUnloaded(status, true)).toBe(false);
    }
  });

  it("sorts recently unloaded blue and green near the top of activity mode, not under project groups", () => {
    const sessions = ["old", "blue", "green", "working"].map((id) => ({ id, title: id }));
    const groups = layoutChatGPTSessions(sessions, [], "activity", {
      old: { age: "unloaded", lastWorkingAt: now - CHATGPT_RECENT_ACTIVITY_MS },
      blue: { age: "unloaded-recent", lastWorkingAt: now - 900 },
      green: { age: "unloaded-working", lastWorkingAt: now - 1000 },
      working: { age: "working", lastWorkingAt: now - 1 },
    });
    expect(groups.flatMap((g) => g.rows.map((row) => row.session.id))).toEqual([
      "working",
      "blue",
      "green",
      "old",
    ]);
  });
});

describe("T3-0235 fresh chat priority", () => {
  const created = [
    { id: "old", title: "Existing", createdAt: 20 },
    { id: "new", title: "New", createdAt: 200, manualEmptyCandidateCreatedAt: 200 },
    { id: "newer", title: "Newer", createdAt: 300, manualEmptyCandidateCreatedAt: 300 },
  ];
  it("pins new Ctrl-Shift-T sessions after deselection until first work or expiry", () => {
    const timestamps: Record<string, number> = {};
    expect(freshManualSessionIds(created, (id) => timestamps[id] ?? 0, 400)).toEqual(["newer", "new"]);
    const groups = [
      {
        key: "group",
        title: null,
        rows: created.map((session) => ({
          session,
          depth: 0,
          childCount: 0,
        })),
      },
    ];
    const pinned = prioritizeFreshManualSession(
      groups,
      freshManualSessionIds(created, () => 0, 400),
    );
    expect(pinned.flatMap((g) => g.rows.map((r) => r.session.id))).toEqual(["newer", "new", "old"]);
    timestamps.newer = 500;
    expect(freshManualSessionIds(created, (id) => timestamps[id] ?? 0, 400)).toEqual(["new"]);
    timestamps.new = 700;
    expect(freshManualSessionIds(created, (id) => timestamps[id] ?? 0, 400)).toEqual([]);
  });

  it("never re-pins an old or explicitly disqualified session, even without recorded work", () => {
    const recent = 10_000_000;
    const candidates = [
      {
        id: "higgsfield",
        title: "Existing conversation",
        createdAt: recent - 1_000,
        manualEmptyCandidateCreatedAt: recent - 1_000,
        manualEmptyCandidateDisqualified: true,
      },
      {
        id: "stale",
        title: "Old empty chat",
        createdAt: recent - FRESH_MANUAL_PRIORITY_MAX_AGE_MS,
        manualEmptyCandidateCreatedAt: recent - FRESH_MANUAL_PRIORITY_MAX_AGE_MS,
      },
      {
        id: "fresh",
        title: "Actually new empty chat",
        createdAt: recent - 1_000,
        manualEmptyCandidateCreatedAt: recent - 1_000,
      },
    ];
    expect(freshManualSessionIds(candidates, () => 0, recent)).toEqual(["fresh"]);
  });

  it("pins a fresh blank chat after working sessions but before the rest of the activity queue", () => {
    const sessions = [
      { id: "fresh", title: "New chat" },
      { id: "working", title: "Active" },
      { id: "idle", title: "Inactive" },
    ];
    const activity = {
      working: { age: "working" as const, lastWorkingAt: 300 },
      fresh: { age: "unknown" as const, lastWorkingAt: 0 },
      idle: { age: "inactive" as const, lastWorkingAt: 200 },
    };
    const groups = layoutChatGPTSessions(sessions, [], "activity", activity);
    const prioritized = prioritizeFreshManualSession(groups, ["fresh"], activity);
    expect(prioritized.flatMap((group) => group.rows.map((row) => row.session.id)))
      .toEqual(["working", "fresh", "idle"]);
    expect(prioritized).toHaveLength(1);
  });
});
