import { describe, expect, it } from "vite-plus/test";

import type { ChatGPTSidebarGroup } from "./chatGPTSessionGrouping";
import { searchChatGPTSessionGroups } from "./chatGPTSessionSearch";

const groups: ChatGPTSidebarGroup[] = [
  {
    key: "project:t3",
    title: "T3 Code",
    rows: [
      { session: { id: "parent", title: "Fix chat nesting" }, depth: 0, childCount: 1 },
      {
        session: { id: "child", title: "Smoke-test child", parentSessionId: "parent" },
        depth: 1,
        childCount: 0,
      },
      { session: { id: "other", title: "Improve search" }, depth: 0, childCount: 0 },
    ],
  },
  {
    key: "other",
    title: "Other",
    rows: [{ session: { id: "one", title: "Cascadeur smoke test" }, depth: 0, childCount: 0 }],
  },
  { key: "unused", title: "Unused", rows: [] },
];

describe("ChatGPT sidebar session search", () => {
  it("leaves original grouped sessions untouched when query is empty", () => {
    const result = searchChatGPTSessionGroups(groups, "  ");
    expect(result).toEqual(groups);
    expect(result[0]).toBe(groups[0]);
  });

  it("matches case-insensitive substrings, removes empty groups, and preserves order", () => {
    const result = searchChatGPTSessionGroups(groups, " SMOKE ");
    expect(result.map((group) => group.key)).toEqual(["project:t3", "other"]);
    expect(result[0]!.rows.map(({ session }) => session.id)).toEqual(["child"]);
    expect(result[1]!.rows.map(({ session }) => session.id)).toEqual(["one"]);
    expect(result[0]!.rows[0]!.depth).toBe(0);
  });

  it("finds all members by project heading even if none of their titles match", () => {
    const result = searchChatGPTSessionGroups(groups, "t3 CODE");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(groups[0]);
    expect(result[0]!.rows).toHaveLength(3);
  });

  it("preserves visible parent-child nesting when both match, without modifying saved data", () => {
    const result = searchChatGPTSessionGroups(groups, "ch");
    expect(result[0]!.rows.map(({ session }) => session.id)).toEqual(["parent", "child", "other"]);
    expect(result[0]!.rows.map(({ depth, childCount }) => ({ depth, childCount }))).toEqual([
      { depth: 0, childCount: 1 },
      { depth: 1, childCount: 0 },
      { depth: 0, childCount: 0 },
    ]);
    expect(groups[0]!.rows[0]!.childCount).toBe(1);
  });

  it("produces no groups for a miss", () => {
    expect(searchChatGPTSessionGroups(groups, "nothing matches")).toEqual([]);
  });
});
