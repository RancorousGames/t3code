import { describe, expect, it } from "vite-plus/test";
import {
  preserveSelectedChatGPTSessionPosition,
  prioritizeChatGPTSessionHighlights,
  selectChatGPTSidebarReplacement,
  sortChatGPTVerificationRows,
} from "./chatGPTSidebarPriority";
import type { ChatGPTSidebarGroup, ChatGPTSessionSortActivity } from "./chatGPTSessionGrouping";

const row = (id: string, borderColor?: string) => ({
  session: { id, title: id, ...(borderColor ? { borderColor } : {}) },
  depth: 0,
  childCount: 0,
});
const group = (key: string, ...rows: ReturnType<typeof row>[]): ChatGPTSidebarGroup => ({
  key,
  title: key.startsWith("status:") ? null : key,
  rows,
});
const ids = (groups: readonly ChatGPTSidebarGroup[]) =>
  groups.flatMap((entry) => entry.rows.map(({ session }) => session.id));
const ages = (values: Record<string, ChatGPTSessionSortActivity["age"]>) =>
  Object.fromEntries(
    Object.entries(values).map(([id, age]) => [id, { age, lastWorkingAt: 0 }]),
  ) as Record<string, ChatGPTSessionSortActivity>;

describe("T3 sidebar selection and highlight priority", () => {
  it("keeps green working rows first, then all color highlights regardless of error, recency or project", () => {
    const base = [
      group("status:activity", row("recent"), row("active"), row("blue", "blue")),
      group("project:old", row("old"), row("error", "red")),
      group("status:verification", row("verification", "purple")),
    ];
    const result = prioritizeChatGPTSessionHighlights(
      base,
      ages({
        recent: "recent",
        active: "working",
        blue: "inactive",
        old: "inactive",
        error: "interrupted",
        verification: "invalid",
      }),
    );
    expect(ids(result)).toEqual(["active", "blue", "error", "verification", "recent", "old"]);
    expect(result[0]?.key).toBe("status:activity");
    expect(ids(base)).toEqual(["recent", "active", "blue", "old", "error", "verification"]);
  });

  it("promotes marked rows even when Started mode grouped them in an old project", () => {
    const result = prioritizeChatGPTSessionHighlights(
      [
        group("project:first", row("plain"), row("highlight", "green")),
        group("project:second", row("working")),
      ],
      ages({ plain: "inactive", highlight: "invalid", working: "working" }),
    );
    expect(ids(result)).toEqual(["working", "highlight", "plain"]);
  });

  it("does not move a selected row as its status or colored priority changes", () => {
    const before = [group("status:activity", row("a"), row("selected"), row("b"))];
    const raw = [group("status:activity", row("selected", "blue"), row("a"), row("b"))];
    const pinned = preserveSelectedChatGPTSessionPosition(raw, before, "selected");
    expect(ids(pinned)).toEqual(["a", "selected", "b"]);
    const later = [
      group("status:activity", row("new-working"), row("selected", "blue"), row("a"), row("b")),
    ];
    const stable = preserveSelectedChatGPTSessionPosition(later, pinned, "selected");
    expect(ids(stable)).toEqual(["new-working", "selected", "a", "b"]);
    expect(ids(preserveSelectedChatGPTSessionPosition(later, pinned, undefined))).toEqual([
      "new-working",
      "selected",
      "a",
      "b",
    ]);
    expect(ids(preserveSelectedChatGPTSessionPosition(raw, before, undefined))).toEqual([
      "selected",
      "a",
      "b",
    ]);
  });

  it("does not resurrect a selected row hidden by a filter or closed", () => {
    const previous = [group("status:activity", row("selected"), row("other"))];
    const filtered = [group("status:activity", row("other"))];
    expect(ids(preserveSelectedChatGPTSessionPosition(filtered, previous, "selected"))).toEqual([
      "other",
    ]);
  });

  it("anchors the same global slot even when priority moves its row into another section", () => {
    const previous = [
      group("status:activity", row("active"), row("selected"), row("recent")),
      group("project:older", row("old")),
    ];
    const updated = [
      group("status:activity", row("selected", "red"), row("active"), row("recent")),
      group("project:older", row("old")),
    ];
    expect(ids(preserveSelectedChatGPTSessionPosition(updated, previous, "selected"))).toEqual([
      "active",
      "selected",
      "recent",
      "old",
    ]);
  });
});

describe("verification queue ordering", () => {
  it("sorts by when marked, oldest first, even when activity puts newer work first", () => {
    const entries = [
      { ...row("newer"), session: { id: "newer", title: "Newer", verificationMarkedAt: 500 } },
      { ...row("old"), session: { id: "old", title: "Old", verificationMarkedAt: 100 } },
      { ...row("middle"), session: { id: "middle", title: "Middle", verificationMarkedAt: 250 } },
    ];
    expect(sortChatGPTVerificationRows(entries).map(({ session }) => session.id))
      .toEqual(["old", "middle", "newer"]);
  });

  it("places legacy verification requests by their available timestamps before newer requests", () => {
    const entries = [
      { ...row("new"), session: { id: "new", title: "New", verificationMarkedAt: 500 } },
      { ...row("old-legacy"), session: { id: "old-legacy", title: "Old legacy", snoozedAt: 100 } },
      { ...row("unknown-legacy"), session: { id: "unknown-legacy", title: "Unknown legacy", createdAt: 50 } },
    ];
    expect(sortChatGPTVerificationRows(entries).map(({ session }) => session.id))
      .toEqual(["unknown-legacy", "old-legacy", "new"]);
  });
});

describe("ChatGPT sidebar replacement selection", () => {
  const sessions = [
    { id: "old", title: "Old", createdAt: 10 },
    { id: "removed", title: "Removed", createdAt: 50 },
    { id: "recent", title: "Recent", createdAt: 40 },
    { id: "hidden", title: "Hidden", hidden: true },
    { id: "snoozed", title: "Snoozed", snoozedUntil: 200 },
    { id: "review", title: "Review", verificationPending: true },
  ];
  const activity: Record<string, ChatGPTSessionSortActivity> = {
    old: { age: "inactive", lastWorkingAt: 5, lastActivityAt: 20 },
    removed: { age: "inactive", lastWorkingAt: 200, lastActivityAt: 200 },
    recent: { age: "inactive", lastWorkingAt: 70, lastActivityAt: 80 },
    hidden: { age: "working", lastWorkingAt: 190, lastActivityAt: 190 },
    snoozed: { age: "inactive", lastWorkingAt: 180, lastActivityAt: 180 },
    review: { age: "inactive", lastWorkingAt: 170, lastActivityAt: 170 },
  };

  it("restores the prior selection even when another session was active more recently", () => {
    expect(selectChatGPTSidebarReplacement(sessions, new Set(["removed"]), "old", activity, 100))
      .toBe("old");
  });

  it("falls back to the most recently active eligible session, not the next sidebar row", () => {
    expect(selectChatGPTSidebarReplacement(sessions, new Set(["removed"]), "hidden", activity, 100))
      .toBe("recent");
    expect(selectChatGPTSidebarReplacement(sessions, new Set(["removed", "recent"]), null, activity, 100))
      .toBe("old");
  });

  it("uses creation order when there is no activity, or returns null when none remain", () => {
    expect(selectChatGPTSidebarReplacement(sessions.slice(0, 3), new Set(["removed"]), null, {}, 100))
      .toBe("recent");
    expect(selectChatGPTSidebarReplacement(sessions, new Set(sessions.map((session) => session.id)), null, activity, 100))
      .toBeNull();
  });
});
