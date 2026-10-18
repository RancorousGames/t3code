import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { BrowserSession, type BrowserSession as Session } from "./chatGPTBrowserSessions";
import { chatGPTParentIndex, resolveExplicitChatGPTParent } from "./chatGPTSessionLineage";
import {
  groupChatGPTSessions,
  layoutChatGPTSessions,
  applyConfirmedChatGPTSessionMetadata,
} from "./chatGPTSessionGrouping";

const projects = [
  { id: "w", title: "Wartribes", workspaceRoot: "D:/Wartribes" },
  { id: "t", title: "t3code", workspaceRoot: "D:/SSDProjects/Tools/t3code" },
];
const parentId = "980c626b-ac62-4a98-b421-2458b6f19312";
const childId = "5d38e296-561d-4e91-91f0-320c7617edce";
const rows = (sessions: readonly Session[], mode: "started" | "activity" = "started") =>
  layoutChatGPTSessions(sessions, projects, mode, {
    [parentId]: { age: "inactive", lastWorkingAt: 0 },
    [childId]: { age: "working", lastWorkingAt: 15 },
    unrelated: { age: "working", lastWorkingAt: 10 },
  }).flatMap((group) => group.rows.map(({ session, depth }) => [session.id, depth]));

describe("explicit ChatGPT spawn parent identity", () => {
  const existing: Session[] = [
    { id: parentId, title: "ChatGPT parent", project: "Wartribes" },
    { id: "unrelated", title: "Another currently generating session", project: "t3code" },
  ];

  it("never infers the caller from an active tab, heartbeat, matching title or project", () => {
    expect(resolveExplicitChatGPTParent(existing, undefined)).toBeNull();
    expect(resolveExplicitChatGPTParent(existing, parentId)?.id).toBe(parentId);
  });

  it("rejects unknown and hidden explicit IDs rather than silently creating another link", () => {
    expect(() => resolveExplicitChatGPTParent(existing, "missing")).toThrow(/Unknown or hidden/);
    expect(() =>
      resolveExplicitChatGPTParent([{ ...existing[0]!, hidden: true }, existing[1]!], parentId),
    ).toThrow(/Unknown or hidden/);
  });

  it("records the supplied T3 UUID even if the parent browser hasn't activated yet", () => {
    const child = {
      id: childId,
      title: "t3code subagent",
      project: "t3code",
      parentSessionId: parentId,
    };
    // Both T3 sort modes follow the *same* exact parent, regardless of other active tabs.
    const sessions = [existing[0]!, existing[1]!, child];
    for (const mode of ["started", "activity"] as const) {
      const rendered = rows(sessions, mode);
      const at = rendered.findIndex(([id]) => id === parentId);
      expect(rendered[at + 1]).toEqual([childId, 1]);
      expect(rendered.filter(([id]) => id === childId)).toHaveLength(1);
    }
    const index = chatGPTParentIndex(sessions);
    expect(index.get(childId)).toBe(parentId);
  });

  it("round-trips session IDs, explicitly chosen parents, project and detach marker across reloads", () => {
    const originals: Session[] = [
      ...existing,
      { id: childId, title: "Subagent", parentSessionId: parentId, project: "t3code" },
      { id: "detached", title: "Detached", parentSessionId: null },
      { id: "chatgpt", title: "Legacy stable ID" },
    ];
    const codec = Schema.fromJsonString(Schema.Array(BrowserSession));
    const restored = Schema.decodeSync(codec)(Schema.encodeSync(codec)(originals));
    expect(restored).toEqual(originals);
    expect(chatGPTParentIndex(restored).get(childId)).toBe(parentId);
    expect(restored.find((s) => s.id === "detached")?.parentSessionId).toBeNull();
    expect(rows(restored, "started")).toContainEqual([childId, 1]);
  });
});

describe("defensive grouping against inconsistent persisted parents", () => {
  it("does not nest orphan or cyclic links, even with separate project hints", () => {
    const members: Session[] = [
      { id: "a", title: "One", project: "Wartribes", parentSessionId: "b" },
      { id: "b", title: "Two", project: "t3code", parentSessionId: "a" },
      { id: "c", title: "Orphan", parentSessionId: "removed", project: "t3code" },
      { id: "d", title: "Valid descendant", parentSessionId: "a" },
    ];
    const parentIndex = chatGPTParentIndex(members);
    expect(Object.fromEntries(parentIndex)).toEqual({
      a: null,
      b: null,
      c: null,
      d: "a",
    });
    for (const mode of ["started", "activity"] as const) {
      const actual = rows(members, mode);
      expect(actual).toHaveLength(4);
      expect(actual).toContainEqual(["a", 0]);
      expect(actual).toContainEqual(["b", 0]);
      expect(actual).toContainEqual(["c", 0]);
      expect(actual).toContainEqual(["d", 1]);
    }
  });

  it("keeps an id stable when the parent is hidden, then reattaches on restore", () => {
    const parent = { id: parentId, title: "Parent", project: "Wartribes", hidden: true };
    const child = { id: childId, title: "Child", parentSessionId: parentId };
    expect(rows([child])).toContainEqual([childId, 0]);
    expect(rows([{ ...parent, hidden: false }, child])).toContainEqual([childId, 1]);
  });

  it("does not silently resurrect a user-detached parent from historic confirmed metadata", () => {
    const fixture = {
      id: "b47774ff-4148-4968-876b-ec4b95d076af",
      title: "OMCP Subagent Spawn Test",
      parentSessionId: null,
    };
    const updated = applyConfirmedChatGPTSessionMetadata([fixture]);
    expect(updated[0]?.parentSessionId).toBeNull();
    expect(groupChatGPTSessions(updated, projects).flatMap((g) => g.rows)[0]?.depth).toBe(0);
  });
});
