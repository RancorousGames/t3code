import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  BrowserSession,
  moveChatGPTSessionProject,
  type BrowserSession as Session,
} from "./chatGPTBrowserSessions";
import { groupChatGPTSessions } from "./chatGPTSessionGrouping";

const projects = [
  { id: "wartribes", title: "Wartribes", workspaceRoot: "D:/Wartribes" },
  { id: "t3code", title: "T3 Code", workspaceRoot: "D:/SSDProjects/Tools/t3code" },
];

describe("dragging ChatGPT sessions between projects", () => {
  it("moves live and hidden descendants recursively, retaining links, order, flags and persistence", () => {
    const sessions: Session[] = [
      { id: "unrelated", title: "Unrelated T3", project: "T3 Code" },
      {
        id: "grandchild",
        title: "Nested worker",
        parentSessionId: "child",
        project: "Other",
        snoozedUntil: 123,
      },
      { id: "ancestor", title: "Original manager", project: "T3 Code" },
      { id: "root", title: "Wartribes manager", project: "T3 Code", parentSessionId: "ancestor" },
      { id: "child", title: "First worker", project: "Other", parentSessionId: "root" },
      {
        id: "hidden",
        title: "Archived worker",
        project: "T3 Code",
        parentSessionId: "grandchild",
        hidden: true,
        hiddenAt: 123,
      },
      {
        id: "sibling",
        title: "Unmoved ancestor child",
        project: "T3 Code",
        parentSessionId: "ancestor",
      },
    ];
    const moved = moveChatGPTSessionProject(sessions, "root", "Wartribes");
    expect(moved.map(({ id }) => id)).toEqual(sessions.map(({ id }) => id));
    expect(moved.filter(({ project }) => project === "Wartribes").map(({ id }) => id)).toEqual([
      "grandchild",
      "root",
      "child",
      "hidden",
    ]);
    expect(moved.find(({ id }) => id === "root")?.parentSessionId).toBeNull();
    expect(moved.find(({ id }) => id === "child")?.parentSessionId).toBe("root");
    expect(moved.find(({ id }) => id === "grandchild")?.parentSessionId).toBe("child");
    expect(moved.find(({ id }) => id === "hidden")).toMatchObject({
      hidden: true,
      hiddenAt: 123,
      parentSessionId: "grandchild",
    });
    expect(moved.find(({ id }) => id === "grandchild")?.snoozedUntil).toBe(123);
    expect(moved.find(({ id }) => id === "unrelated")).toBe(sessions[0]);
    expect(moved.find(({ id }) => id === "ancestor")).toBe(sessions[2]);
    expect(moved.find(({ id }) => id === "sibling")).toBe(sessions[6]);
    expect(sessions.find(({ id }) => id === "root")?.parentSessionId).toBe("ancestor");

    const codec = Schema.fromJsonString(Schema.Array(BrowserSession));
    const restored = Schema.decodeSync(codec)(Schema.encodeSync(codec)(moved));
    expect(restored).toEqual(moved);
    const targetRows = groupChatGPTSessions(restored, projects).find(
      ({ title }) => title === "Wartribes",
    )?.rows;
    expect(targetRows?.map(({ session, depth }) => [session.id, depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
      ["hidden", 3],
    ]);
    expect(
      groupChatGPTSessions(restored, projects)
        .find(({ title }) => title === "T3 Code")
        ?.rows.some(({ session }) => session.id === "sibling"),
    ).toBe(true);
  });

  it("detaches only the dragged child and its subtree when moving into Other", () => {
    const sessions: Session[] = [
      { id: "manager", title: "Manager", project: "Wartribes" },
      { id: "child", title: "Worker", parentSessionId: "manager", project: "Wartribes" },
      { id: "grandchild", title: "Reviewer", parentSessionId: "child", project: "Wartribes" },
      { id: "sibling", title: "Another worker", parentSessionId: "manager", project: "Wartribes" },
    ];
    const moved = moveChatGPTSessionProject(sessions, "child", null);
    expect(
      moved.map(({ id, project, parentSessionId }) => [id, project, parentSessionId ?? null]),
    ).toEqual([
      ["manager", "Wartribes", null],
      ["child", "Other", null],
      ["grandchild", "Other", "child"],
      ["sibling", "Wartribes", "manager"],
    ]);
  });

  it("is bounded on corrupt parent cycles and never changes unrelated or missing sessions", () => {
    const sessions: Session[] = [
      { id: "a", title: "A", parentSessionId: "b", project: "T3 Code" },
      { id: "b", title: "B", parentSessionId: "a", project: "T3 Code" },
      { id: "leaf", title: "Leaf", parentSessionId: "b", project: "T3 Code" },
      { id: "orphan", title: "Orphan", parentSessionId: "missing", project: "Other" },
    ];
    const moved = moveChatGPTSessionProject(sessions, "a", "Wartribes");
    expect(moved.map(({ project }) => project)).toEqual([
      "Wartribes",
      "Wartribes",
      "Wartribes",
      "Other",
    ]);
    expect(moved[0]?.parentSessionId).toBeNull();
    expect(moved[1]?.parentSessionId).toBe("a");
    expect(moveChatGPTSessionProject(sessions, "missing", "Wartribes")).toEqual(sessions);
  });
});
