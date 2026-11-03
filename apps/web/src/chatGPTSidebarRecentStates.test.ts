import { describe, expect, it } from "vite-plus/test";
import {
  chatGPTActivityColorClass,
  hideChatGPTSessionAsUnloaded,
  unloadedChatGPTActivityAge,
  CHATGPT_RECENT_ACTIVITY_MS,
} from "./components/sidebar/chatGPTActivity";
import { layoutChatGPTSessions } from "./chatGPTSessionGrouping";
import { freshManualSessionIds, prioritizeFreshManualSession } from "./chatGPTFreshManualSession";

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

  it("Hide Unloaded never removes either recent colored state", () => {
    expect(hideChatGPTSessionAsUnloaded("unloaded", true)).toBe(true);
    for (const status of ["unloaded-working", "unloaded-recent", "recent", "working"] as const) {
      expect(hideChatGPTSessionAsUnloaded(status, true)).toBe(false);
    }
    expect(hideChatGPTSessionAsUnloaded("unloaded", false)).toBe(false);
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
      "green",
      "blue",
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
  it("pins new Ctrl-Shift-T sessions after deselection and drops them only after first work", () => {
    const timestamps: Record<string, number> = {};
    expect(freshManualSessionIds(created, (id) => timestamps[id] ?? 0)).toEqual(["newer", "new"]);
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
      freshManualSessionIds(created, () => 0),
    );
    expect(pinned.flatMap((g) => g.rows.map((r) => r.session.id))).toEqual(["newer", "new", "old"]);
    timestamps.newer = 500;
    expect(freshManualSessionIds(created, (id) => timestamps[id] ?? 0)).toEqual(["new"]);
    timestamps.new = 700;
    expect(freshManualSessionIds(created, (id) => timestamps[id] ?? 0)).toEqual([]);
  });
});
