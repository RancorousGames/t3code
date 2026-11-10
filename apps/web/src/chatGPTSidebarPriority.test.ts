import { describe, expect, it } from "vite-plus/test";
import {
  preserveSelectedChatGPTSessionPosition,
  prioritizeChatGPTSessionHighlights,
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
