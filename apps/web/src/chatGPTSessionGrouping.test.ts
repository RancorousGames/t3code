import { describe, expect, it } from "vite-plus/test";

import {
  applyConfirmedChatGPTSessionMetadata,
  groupChatGPTSessions,
  layoutChatGPTSessions,
  matchRegisteredProject,
  matchChatGPTTaskBoardProject,
  withTaskBoardPermanentProjects,
} from "./chatGPTSessionGrouping";

const projects = [
  { id: "altraea", title: "Settling Altraea", workspaceRoot: "D:/SSDProjects/SettlingAltraea" },
  { id: "wartribes", title: "Wartribes", workspaceRoot: "D:/Wartribes" },
  {
    id: "citizen",
    title: "Citizen Imperium",
    workspaceRoot: "D:/SSDProjects/Unreal/CitizenImperium",
  },
];

describe("ChatGPT session project grouping", () => {
  it("keeps permanent groups, prioritizes matching titles and removes bias on unpin", () => {
    const pinned = [{ key: "name:cascadeur", title: "Cascadeur" }];
    const sessions = [
      { id: "a", title: "Cascadeur IK Research" },
      { id: "b", title: "Cascadeur plugin" },
      { id: "c", title: "Unrelated project" },
    ];
    const groups = groupChatGPTSessions(sessions, projects, pinned);
    expect(groups[0]?.key).toBe("name:cascadeur");
    expect(groups[0]?.rows.map((row) => row.session.id)).toEqual(["a", "b"]);
    expect(groupChatGPTSessions([], projects, pinned)[0]?.title).toBe("Cascadeur");
    const afterUnpin = groupChatGPTSessions(
      [{ id: "a", title: "Cascadeur IK Research" }],
      projects,
    );
    expect(afterUnpin.some((group) => group.key === "name:cascadeur")).toBe(false);
  });

  it("reuses confirmed training without a manually maintained keyword list", () => {
    const lab = {
      id: "animationLab",
      title: "WartribesAnimationLab",
      workspaceRoot: "D:/SSDProjects/Tools/WartribesAnimationLab",
    };
    const corpus = [
      { id: "sim", title: "sim speedup" },
      { id: "grapple", title: "GRAPPLE MAIN" },
      { id: "combat", title: "COMBAT TASKS" },
      { id: "anim", title: "anim tool improvements" },
    ];
    const confirmed = groupChatGPTSessions(
      [...corpus, { id: "fa21bc55-3a43-4943-8bee-4493a6678a81", title: "anim tool improvements" }],
      [...projects, lab],
    );
    expect(
      confirmed
        .find((group) => group.key === "project:animationLab")
        ?.rows.some(({ session }) => session.id === "fa21bc55-3a43-4943-8bee-4493a6678a81"),
    ).toBe(true);
    expect(matchRegisteredProject("GRAPPLE MAIN", [...projects, lab])?.id).toBe("wartribes");
    expect(matchRegisteredProject("COMBAT TASKS", [...projects, lab])?.id).toBe("wartribes");
  });

  it("never silently attributes an unlinked OMCP child from build-global historical labels", () => {
    const root = {
      id: "2e2b839c-0835-4a86-90bc-fc6511c180f2",
      title: "Try spawning a chatgpt subagent using omcp for a test",
    };
    const spawned = {
      id: "b47774ff-4148-4968-876b-ec4b95d076af",
      title: "OMCP Subagent Spawn Test",
    };
    // A build-global historical label is not scoped to this environment. The
    // same IDs could exist in a copied workspace with an unrelated lineage.
    const raw = [root, spawned];
    expect(applyConfirmedChatGPTSessionMetadata(raw)[1]?.parentSessionId).toBeUndefined();
    const unrelatedRows = groupChatGPTSessions(raw, projects).flatMap((group) => group.rows);
    expect(unrelatedRows.map(({ session, depth }) => [session.id, depth])).toEqual([
      [root.id, 0],
      [spawned.id, 0],
    ]);
    const linked = groupChatGPTSessions(
      [root, { ...spawned, parentSessionId: root.id }],
      projects,
    ).flatMap((group) => group.rows);
    expect(linked.map(({ session, depth }) => [session.id, depth])).toEqual([
      [root.id, 0],
      [spawned.id, 1],
    ]);
  });

  it("nests a hinted child under an unassigned Other parent", () => {
    const groups = groupChatGPTSessions(
      [
        { id: "root", title: "Unclassified root" },
        {
          id: "subagent",
          title: "Wartribes implement combat",
          project: "Wartribes",
          parentSessionId: "root",
        },
      ],
      projects,
    );
    const other = groups.find((group) => group.key === "other");
    expect(other?.rows.map(({ session, depth }) => [session.id, depth])).toEqual([
      ["root", 0],
      ["subagent", 1],
    ]);
  });

  it("does not invent generic name-based groups", () => {
    const groups = groupChatGPTSessions(
      [
        { id: "one", title: "Try using omcp to inspect a browser" },
        { id: "two", title: "Begin using old models" },
        { id: "three", title: "Complete using documented interface" },
      ],
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.title).toBe("Other");
  });

  it("rejects action words as inferred projects, including old persisted bad hints", () => {
    const actionWords = [
      "Implement", "Investigate", "Analyze", "Test", "Check", "Review",
      "Fix", "Debug", "Verify", "Build", "Research", "Create", "Plan",
    ];
    const sessions = actionWords.flatMap((action, index) => [
      { id: `one-${index}`, title: `${action} the sidebar behavior` },
      { id: `two-${index}`, title: `${action} another issue`, project: action },
    ]);
    const groups = groupChatGPTSessions(sessions, []);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("other");
    expect(groups[0]?.rows).toHaveLength(sessions.length);
    const older = layoutChatGPTSessions(
      sessions, [], "activity", {}, [], undefined, true, Date.now(),
    );
    expect(older.map((group) => group.title)).toEqual(["Other"]);
  });

  it("can still use explicitly registered or pinned projects with generic names", () => {
    const registered = [{ id: "test", title: "Test", workspaceRoot: "D:/Projects/Test" }];
    const pinned = [{ key: "pin:investigate", title: "Investigate" }];
    expect(matchRegisteredProject("Test", registered)?.id).toBe("test");
    const groups = groupChatGPTSessions([
      { id: "one", title: "Test systems", project: "Test" },
      { id: "two", title: "Test performance", project: "Test" },
      { id: "three", title: "Investigate client", project: "Investigate" },
      { id: "four", title: "Investigate server", project: "Investigate" },
    ], registered, pinned);
    expect(groups.map((group) => [group.key, group.title, group.rows.map(({session}) => session.id)])).toEqual([
      ["pin:investigate", "Investigate", ["three", "four"]],
      ["project:test", "Test", ["one", "two"]],
    ]);
    expect(groups.some((group) => group.key === "pin:investigate" && group.rows.length === 2)).toBe(true);
  });

  it("reassigns stale generic inferred hints to a real project when the title identifies one", () => {
    const groups = groupChatGPTSessions([
      { id: "one", title: "Implement Wartribes combat", project: "Implement" },
      { id: "two", title: "Investigate Wartribes foliage", project: "Investigate" },
    ], projects);
    expect(groups.find((group) => group.title === "Wartribes")
      ?.rows.map((row) => row.session.id)).toEqual(["one", "two"]);
    expect(groups.some((group) => ["Implement", "Investigate"].includes(group.title ?? ""))).toBe(false);
  });

  it("creates permanent TaskBoard projects and assigns title task IDs by board prefix", () => {
    const taskBoards = [
      { key: "taskboard:wartribes", title: "Wartribes", prefixes: ["WT-", "WTE-"] },
      { key: "taskboard:t3code", title: "t3code", prefixes: ["T3-", "T3E-"] },
      { key: "taskboard:orderofthefallen", title: "Order of the Fallen", prefixes: ["OTF-"] },
    ];
    const permanent = withTaskBoardPermanentProjects(
      [{ key: "hint:wartribes", title: "Wartribes" }],
      taskBoards,
    );
    expect(permanent.filter((p) => p.title === "Wartribes")).toHaveLength(1);
    const sessions = [
      { id: "wt", title: "Implement WT-0461 one-click tour", project: "Implement" },
      { id: "wte", title: "WTE-0004 Folio infrastructure" },
      { id: "t3", title: "Investigate T3-0235", project: "Other" },
      { id: "otf", title: "Order of the Fallen OTF-0819 expedition" },
      { id: "wt-lower", title: "test wt-0999 fix", project: "Investigate" },
      { id: "prefix-collision", title: "SWT-0032 unrelated" },
      { id: "non-id", title: "WT-general design" },
      { id: "registered-path", title: "General combat improvements", project: "D:/Wartribes" },
    ];
    const groups = groupChatGPTSessions(sessions, projects, permanent, taskBoards);
    const map = new Map(groups.flatMap((g) => g.rows.map((row) => [row.session.id, g.key])));
    expect(map.get("wt")).toBe("taskboard:wartribes");
    expect(map.get("wte")).toBe("taskboard:wartribes");
    expect(map.get("wt-lower")).toBe("taskboard:wartribes");
    expect(map.get("t3")).toBe("taskboard:t3code");
    expect(map.get("otf")).toBe("taskboard:orderofthefallen");
    expect(map.get("prefix-collision")).toBe("other");
    expect(map.get("non-id")).toBe("other");
    expect(map.get("registered-path")).toBe("taskboard:wartribes");
    expect(withTaskBoardPermanentProjects(
      [{ key: "pin:old-t3", title: "T3 Code" }], taskBoards,
    ).filter((p) => p.key === "taskboard:t3code")).toHaveLength(1);
    expect(matchChatGPTTaskBoardProject("WT-0461", taskBoards)?.title).toBe("Wartribes");
    expect(matchChatGPTTaskBoardProject("T3-0235", taskBoards)?.title).toBe("t3code");
    expect(matchChatGPTTaskBoardProject("SWT-0461", taskBoards)).toBeNull();
  });

  it("matches T3's registered project names or workspace directories", () => {
    expect(matchRegisteredProject("Altraea 1v1 Opus Empire", projects)?.id).toBe("altraea");
    expect(matchRegisteredProject("Wartribes combat", projects)?.id).toBe("wartribes");
    expect(matchRegisteredProject("Citizen Imperium patrols", projects)?.id).toBe("citizen");
    expect(matchRegisteredProject("generic changes", projects)).toBeNull();
  });

  it("groups matching projects and nests exact parent-child chains", () => {
    const groups = groupChatGPTSessions(
      [
        { id: "a", title: "Altraea 1v1" },
        { id: "b", title: "Generic child", parentSessionId: "a" },
        { id: "c", title: "Review task", parentSessionId: "b" },
        { id: "d", title: "Wartribes grappling" },
        { id: "e", title: "Wartribes animation" },
        { id: "f", title: "Altraea economy" },
        { id: "g", title: "Citizen Imperium AI" },
        { id: "h", title: "Citizen Imperium city" },
      ],
      projects,
    );
    expect(groups.map((group) => group.title)).toEqual([
      "Settling Altraea",
      "Wartribes",
      "Citizen Imperium",
    ]);
    expect(groups[0]?.rows.map(({ session, depth }) => [session.id, depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["f", 0],
    ]);
    expect(groups[1]?.rows.map(({ session }) => session.id)).toEqual(["d", "e"]);
  });

  it("groups repeated distinct keywords without a project registration", () => {
    const groups = groupChatGPTSessions(
      [
        { id: "one", title: "Cascadeur rigging" },
        { id: "two", title: "Cascadeur timelines" },
        { id: "other", title: "Review code" },
      ],
      [],
    );
    expect(groups[0]?.title?.toLowerCase()).toBe("cascadeur");
    expect(groups[0]?.rows.map(({ session }) => session.id)).toEqual(["one", "two"]);
    expect(groups[1]?.rows.map(({ session }) => session.id)).toEqual(["other"]);
  });

  it("preserves all rows if the parent is missing or the relationship is cyclic", () => {
    const groups = groupChatGPTSessions(
      [
        { id: "a", title: "Alpha", parentSessionId: "b" },
        { id: "b", title: "Beta", parentSessionId: "a" },
        { id: "c", title: "Orphan", parentSessionId: "deleted" },
      ],
      [],
    );
    const rows = groups.flatMap((group) => group.rows);
    expect(rows.map(({ session }) => session.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("takes an explicit project hint and does not create a header for one session", () => {
    const groups = groupChatGPTSessions(
      [
        { id: "a", title: "Generic task", project: "D:/Wartribes" },
        { id: "b", title: "Further work", project: "Wartribes" },
        { id: "c", title: "Citizen Imperium one-off" },
      ],
      projects,
    );
    expect(groups.map((group) => group.title)).toEqual(["Wartribes", "Other"]);
    expect(groups[0]?.rows.map(({ session }) => session.id)).toEqual(["a", "b"]);
    expect(groups[1]?.rows.map(({ session }) => session.id)).toEqual(["c"]);
  });
});

describe("ChatGPT global activity and creation sorting", () => {
  const now = 2_000_000_000;
  const hour = 60 * 60_000;
  const ids = (groups: ReturnType<typeof layoutChatGPTSessions>) =>
    groups.flatMap((group) => group.rows.map(({ session }) => session.id));

  it("keeps Started mode's original project and parent grouping", () => {
    const sessions = [
      { id: "child", title: "Child", parentSessionId: "parent", project: "Alpha" },
      { id: "parent", title: "Parent", project: "Alpha" },
      { id: "other", title: "Other", project: "Zulu" },
    ];
    expect(layoutChatGPTSessions(sessions, [], "started", {}))
      .toEqual(groupChatGPTSessions(sessions, []));
  });

  it("sorts all idle sessions by most recent actual work, even across projects and after 24h", () => {
    const sessions = [
      { id: "old-zulu", title: "Zulu", project: "Zulu" },
      { id: "new-alpha", title: "Alpha", project: "Alpha" },
      { id: "middle", title: "Middle", project: "Zulu" },
    ];
    const activity = {
      "old-zulu": { age: "inactive" as const, lastWorkingAt: now - 80 * hour },
      "new-alpha": { age: "inactive" as const, lastWorkingAt: now - 26 * hour },
      middle: { age: "unloaded" as const, lastWorkingAt: now - 55 * hour },
    };
    const groups = layoutChatGPTSessions(sessions, [], "activity", activity, [], undefined, true, now);
    expect(ids(groups)).toEqual(["new-alpha", "middle", "old-zulu"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("status:activity");
  });

  it("puts working children above idle parents without moving the parent upward", () => {
    const sessions = [
      { id: "parent", title: "Idle manager", project: "Alpha" },
      { id: "child", title: "Working child", parentSessionId: "parent", project: "Alpha" },
      { id: "other", title: "Other working", project: "Zulu" },
    ];
    const activities = {
      parent: { age: "inactive" as const, lastWorkingAt: 10 },
      child: { age: "working" as const, lastWorkingAt: 20 },
      other: { age: "working" as const, lastWorkingAt: 30 },
    };
    expect(ids(layoutChatGPTSessions(sessions, [], "activity", activities)))
      .toEqual(["child", "other", "parent"]);
    expect(layoutChatGPTSessions(sessions, [], "activity", activities)[0]?.rows
      .every(({ depth }) => depth === 0)).toBe(true);
  });

  it("does not promote a grey session over a blue session from a sidebar click", () => {
    const sessions = [
      { id: "grey", title: "Grey", lastDirectInteractionAt: now - 1_000 },
      { id: "blue", title: "Blue" },
    ];
    const activities = {
      grey: { age: "inactive" as const, lastWorkingAt: now - 3 * hour, lastActivityAt: now - 1_000 },
      blue: { age: "recent" as const, lastWorkingAt: now - hour },
    };
    expect(ids(layoutChatGPTSessions(sessions, [], "activity", activities, [], undefined, true, now)))
      .toEqual(["blue", "grey"]);
  });

  it("does not let a highlight, error state, or project override the timestamp", () => {
    const sessions = [
      { id: "highlight", title: "Highlighted", borderColor: "red", project: "Zulu" },
      { id: "error", title: "Error", project: "Alpha" },
      { id: "newest", title: "Newest", project: "Beta" },
    ];
    const activities = {
      highlight: { age: "inactive" as const, lastWorkingAt: 10 },
      error: { age: "invalid" as const, lastWorkingAt: 20 },
      newest: { age: "inactive" as const, lastWorkingAt: 30 },
    };
    expect(ids(layoutChatGPTSessions(sessions, [], "activity", activities)))
      .toEqual(["newest", "error", "highlight"]);
  });

  it("falls back to creation time for sessions with tied or missing work history", () => {
    const sessions = [
      { id: "old", title: "Old", createdAt: 2 },
      { id: "recently-created", title: "Recent", createdAt: 3 },
      { id: "worked", title: "Worked", createdAt: 1 },
    ];
    const activities = {
      old: { age: "inactive" as const, lastWorkingAt: 0 },
      "recently-created": { age: "inactive" as const, lastWorkingAt: 0 },
      worked: { age: "inactive" as const, lastWorkingAt: 20 },
    };
    expect(ids(layoutChatGPTSessions(sessions, [], "activity", activities)))
      .toEqual(["worked", "recently-created", "old"]);
  });

  it("offers Working → Creation as an independent activity mode", () => {
    const sessions = [
      { id: "old-working", title: "Working", createdAt: 1, parentSessionId: "new-idle" },
      { id: "older-idle", title: "Older", createdAt: 10 },
      { id: "new-idle", title: "Newer", createdAt: 30 },
    ];
    const activities = {
      "old-working": { age: "working" as const, lastWorkingAt: 2 },
      "older-idle": { age: "inactive" as const, lastWorkingAt: 100 },
      "new-idle": { age: "inactive" as const, lastWorkingAt: 1 },
    };
    expect(ids(layoutChatGPTSessions(sessions, [], "created", activities)))
      .toEqual(["old-working", "new-idle", "older-idle"]);
    expect(ids(layoutChatGPTSessions(sessions, [], "activity", activities)))
      .toEqual(["old-working", "older-idle", "new-idle"]);
  });
});