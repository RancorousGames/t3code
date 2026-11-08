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

describe("ChatGPT last-active/status sorting", () => {
  const sessions = [
    { id: "idleAltraea", title: "Altraea idle" },
    { id: "workingWartribes", title: "Wartribes working" },
    { id: "recentAltraea", title: "Altraea recent" },
    { id: "idleWartribes", title: "Wartribes idle" },
    { id: "idleWartribes2", title: "Wartribes reviews" },
    { id: "workingAltraea", title: "Altraea working" },
    { id: "idleAltraea2", title: "Altraea economy" },
    { id: "interrupted", title: "Cascadeur research" },
    { id: "invalid", title: "Other task" },
  ];
  const byId = {
    idleAltraea: { age: "inactive" as const, lastWorkingAt: 100 },
    workingWartribes: { age: "working" as const, lastWorkingAt: 400 },
    recentAltraea: { age: "recent" as const, lastWorkingAt: 350 },
    idleWartribes: { age: "inactive" as const, lastWorkingAt: 150 },
    idleWartribes2: { age: "inactive" as const, lastWorkingAt: 200 },
    workingAltraea: { age: "working" as const, lastWorkingAt: 500 },
    idleAltraea2: { age: "inactive" as const, lastWorkingAt: 200 },
    interrupted: { age: "interrupted" as const, lastWorkingAt: 300 },
    invalid: { age: "invalid" as const, lastWorkingAt: 250 },
  };
  it("keeps original grouped ordering in Started mode even with activity data", () => {
    const actual = layoutChatGPTSessions(sessions, projects, "started", byId);
    const expected = groupChatGPTSessions(sessions, projects);
    expect(actual).toEqual(expected);
  });
  it("shows each project once after the recent queue, without projectless rows splitting its sessions", () => {
    const now = 2_000_000_000;
    const hour = 60 * 60_000;
    const sessions = [
      { id: "old-t3-1", title: "T3 worker one", project: "t3code" },
      { id: "old-other", title: "Unassigned old chat" },
      { id: "old-alpha", title: "Alpha chat", project: "Alpha" },
      { id: "recent", title: "Work from last night", project: "t3code" },
      { id: "old-t3-2", title: "T3 worker two", project: "T3 Code" },
      { id: "error", title: "Broken chat", project: "Alpha" },
      { id: "old-t3-3", title: "T3 worker three", project: "t3code" },
    ];
    const ages = Object.fromEntries(sessions.map((session) => [
      session.id, {
        age: session.id === "error" ? "invalid" as const : "unloaded" as const,
        lastWorkingAt: session.id === "recent" ? now - 12 * hour : now - 28 * hour,
      },
    ]));
    const groups = layoutChatGPTSessions(sessions, [], "activity", ages, [], undefined, true, now);
    const normalizedTitle = (title: string | null) => title?.toLowerCase().replace(/[\s_-]+/g, "") ?? null;
    expect(groups.map((group) => normalizedTitle(group.title))).toEqual([
      null, "alpha", "t3code", "other", "errors",
    ]);
    expect(groups[0]?.rows.map((row) => row.session.id)).toEqual(["recent"]);
    expect(groups.find((group) => normalizedTitle(group.title) === "t3code")?.rows.map((row) => row.session.id))
      .toEqual(["old-t3-1", "old-t3-2", "old-t3-3"]);
    const ids = groups.flatMap((group) => group.rows.map((row) => row.session.id));
    expect(ids).toHaveLength(sessions.length);
    expect(new Set(ids).size).toBe(sessions.length);
    expect(groups.filter((group) => normalizedTitle(group.title) === "t3code")).toHaveLength(1);
  });

  it("globally sorts activity across projects, including idle chats, before errors", () => {
    const groups = layoutChatGPTSessions(sessions, projects, "activity", byId);
    expect(groups[0]?.key).toBe("status:activity");
    expect(groups.at(-1)?.key).toBe("status:errors");
    expect(groups.flatMap((group) => group.rows.map(({ session, depth }) => [session.id, depth]))).toEqual([
      ["workingWartribes", 0],
      ["workingAltraea", 0],
      ["recentAltraea", 0],
      ["idleAltraea2", 0],
      ["idleAltraea", 0],
      ["idleWartribes2", 0],
      ["idleWartribes", 0],
      ["interrupted", 0],
      ["invalid", 0],
    ]);
  });

  it("keeps all working rows stable when their heartbeats change while recent rows remain time ordered", () => {
    const rows = [
      { id: "one", title: "Wartribes work A" },
      { id: "two", title: "Wartribes work B" },
      { id: "recentA", title: "Altraea recent A" },
      { id: "recentB", title: "Altraea recent B" },
    ];
    const first = layoutChatGPTSessions(rows, projects, "activity", {
      one: { age: "working", lastWorkingAt: 100 },
      two: { age: "working", lastWorkingAt: 200 },
      recentA: { age: "recent", lastWorkingAt: 500 },
      recentB: { age: "recent", lastWorkingAt: 700 },
    });
    const later = layoutChatGPTSessions(rows, projects, "activity", {
      one: { age: "working", lastWorkingAt: 9_999 },
      two: { age: "working", lastWorkingAt: 201 },
      recentA: { age: "recent", lastWorkingAt: 900 },
      recentB: { age: "recent", lastWorkingAt: 701 },
    });
    expect(first[0]?.rows.map(({ session }) => session.id)).toEqual([
      "one",
      "two",
      "recentB",
      "recentA",
    ]);
    expect(later[0]?.rows.map(({ session }) => session.id)).toEqual([
      "one",
      "two",
      "recentA",
      "recentB",
    ]);
  });

  it("sorts yesterday's idle and unloaded sessions by use time for 24 hours, then by project", () => {
    const now = 2_000_000_000;
    const hour = 60 * 60_000;
    const sessions = [
      { id: "old-zulu", title: "Old Zulu", project: "Zulu" },
      { id: "yesterday-zulu", title: "Yesterday Zulu", project: "Zulu" },
      { id: "old-alpha", title: "Old Alpha", project: "Alpha" },
      { id: "yesterday-alpha", title: "Yesterday Alpha", project: "Alpha" },
      { id: "old-gamma", title: "Old Gamma", project: "Gamma" },
      { id: "exact-cutoff", title: "At cutoff", project: "Beta" },
    ];
    const activity = {
      "old-zulu": { age: "unloaded" as const, lastWorkingAt: now - 25 * hour },
      "yesterday-zulu": { age: "unloaded" as const, lastWorkingAt: now - 8 * hour },
      "old-alpha": { age: "inactive" as const, lastWorkingAt: now - 26 * hour },
      "yesterday-alpha": { age: "inactive" as const, lastWorkingAt: now - 3 * hour },
      "old-gamma": { age: "unloaded" as const, lastWorkingAt: 0 },
      "exact-cutoff": { age: "unloaded" as const, lastWorkingAt: now - 24 * hour },
    };
    const ids = layoutChatGPTSessions(
      sessions, [], "activity", activity, [], undefined, true, now,
    ).flatMap((group) => group.rows.map(({ session }) => session.id));
    expect(ids).toEqual([
      "yesterday-alpha", "yesterday-zulu", "old-alpha", "exact-cutoff",
      "old-gamma", "old-zulu",
    ]);
  });

  it("uses interaction timestamps even if an unloaded session never produced a working heartbeat", () => {
    const now = 2_000_000_000;
    const hour = 60 * 60_000;
    const sessions = [
      { id: "old", title: "Old", project: "Alpha" },
      { id: "clicked", title: "Clicked", project: "Zulu", lastDirectInteractionAt: now - 2 * hour },
      { id: "working", title: "Worked", project: "Alpha" },
    ];
    const ids = layoutChatGPTSessions(sessions, [], "activity", {
      old: { age: "unloaded", lastWorkingAt: now - 48 * hour },
      clicked: { age: "unloaded", lastWorkingAt: 0 },
      working: { age: "inactive", lastWorkingAt: now - 4 * hour },
    }, [], undefined, true, now).flatMap((group) => group.rows.map(({ session }) => session.id));
    expect(ids).toEqual(["clicked", "working", "old"]);
  });

  it("does not group recently used children under older project trees", () => {
    const now = 2_000_000_000;
    const sessions = [
      { id: "parent", title: "Old parent", project: "Alpha" },
      { id: "child", title: "Recently used child", parentSessionId: "parent", project: "Alpha" },
      { id: "older-child", title: "Old child", parentSessionId: "parent", project: "Alpha" },
    ];
    const groups = layoutChatGPTSessions(sessions, [], "activity", {
      parent: { age: "unloaded", lastWorkingAt: now - 48 * 60 * 60_000 },
      child: { age: "inactive", lastWorkingAt: now - 14 * 60 * 60_000 },
      "older-child": { age: "unloaded", lastWorkingAt: now - 48 * 60 * 60_000 },
    }, [], undefined, true, now);
    expect(groups.flatMap((group) => group.rows.map(({ session, depth }) => [session.id, depth]))).toEqual([
      ["child", 0], ["parent", 0], ["older-child", 1],
    ]);
  });

  it("keeps permanent project assignments in Started while activity is flat", () => {
    const pinned = [{ key: "pin:wartribes", title: "Wartribes" }];
    const assigned = [
      { id: "wt-old", title: "Older worker", project: "Wartribes" },
      { id: "alt-new", title: "Newer worker", project: "Settling Altraea" },
      { id: "wt-new", title: "Latest worker", project: "Wartribes" },
    ];
    const activity = {
      "wt-old": { age: "inactive" as const, lastWorkingAt: 10 },
      "alt-new": { age: "inactive" as const, lastWorkingAt: 40 },
      "wt-new": { age: "inactive" as const, lastWorkingAt: 50 },
    };
    const global = layoutChatGPTSessions(assigned, projects, "activity", activity, pinned);
    expect(global.map((group) => group.title)).toEqual(["Settling Altraea", "Wartribes"]);
    expect(global.flatMap((group) => group.rows.map(({ session }) => session.id))).toEqual([
      "alt-new",
      "wt-new",
      "wt-old",
    ]);
    expect(global[0]?.rows[0]?.session.project).toBe("Settling Altraea");

    const started = layoutChatGPTSessions(assigned, projects, "started", activity, pinned);
    expect(started[0]?.key).toBe("pin:wartribes");
    expect(started[0]?.rows.map(({ session }) => session.id)).toEqual(["wt-old", "wt-new"]);
  });

  it("keeps working children above inactive managers with a single contextual header", () => {
    const sessions = [
      { id: "parent", title: "Wartribes manager" },
      { id: "working-child", title: "Working child", parentSessionId: "parent" },
      { id: "recent-grandchild", title: "Recent grandchild", parentSessionId: "working-child" },
      { id: "recent-sibling", title: "Recent sibling", parentSessionId: "parent" },
      { id: "working-other", title: "Altraea worker" },
      { id: "idle-child", title: "Idle child", parentSessionId: "parent" },
    ];
    const grouped = layoutChatGPTSessions(sessions, projects, "activity", {
      parent: { age: "inactive", lastWorkingAt: 0 },
      "working-child": { age: "working", lastWorkingAt: 50 },
      "recent-grandchild": { age: "recent", lastWorkingAt: 40 },
      "recent-sibling": { age: "recent", lastWorkingAt: 30 },
      "working-other": { age: "working", lastWorkingAt: 1_000 },
      "idle-child": { age: "inactive", lastWorkingAt: 10 },
    });
    expect(grouped[0]?.key).toBe("status:activity");
    expect(
      grouped.flatMap((group) => group.rows.map(({ session, depth, childCount, inactiveParentHeader }) => [
        session.id,
        depth,
        childCount,
        inactiveParentHeader ?? null,
      ])),
    ).toEqual([
      ["working-child", 0, 0, "Wartribes manager"],
      ["working-other", 0, 0, null],
      ["recent-grandchild", 0, 0, null],
      ["recent-sibling", 0, 0, null],
      ["parent", 0, 1, null],
      ["idle-child", 1, 0, null],
    ]);
    // Working parents are already visible in the active list, so no label.
    const activeParentRows = layoutChatGPTSessions(sessions, projects, "activity", {
      parent: { age: "working", lastWorkingAt: 60 },
      "working-child": { age: "working", lastWorkingAt: 50 },
      "working-other": { age: "working", lastWorkingAt: 100 },
    })[0]?.rows;
    expect(activeParentRows?.slice(0, 2).map(({ session, depth }) => [session.id, depth])).toEqual([
      ["parent", 0],
      ["working-child", 1],
    ]);
    expect(
      activeParentRows?.find(({ session }) => session.id === "working-child")?.inactiveParentHeader,
    ).toBeUndefined();
    // Activity layout never modifies the underlying project/parent identity.
    expect(sessions[1]?.parentSessionId).toBe("parent");
    expect(
      groupChatGPTSessions(sessions, projects)
        .flatMap((group) => group.rows)
        .find(({ session }) => session.id === "working-child")?.depth,
    ).toBe(1);
  });

  it("keeps idle and unloaded children beneath their parent but leaves recent activity global", () => {
    const sessions = [
      { id: "unloaded", title: "Unloaded", parentSessionId: "parent" },
      { id: "other", title: "Other" },
      { id: "parent", title: "Manager" },
      { id: "recent", title: "Recent", parentSessionId: "parent" },
      { id: "idle", title: "Idle", parentSessionId: "parent" },
      { id: "errored", title: "Error", parentSessionId: "parent" },
    ];
    const rows = layoutChatGPTSessions(sessions, [], "activity", {
      unloaded: { age: "unloaded", lastWorkingAt: 0 },
      other: { age: "recent", lastWorkingAt: 80 },
      parent: { age: "inactive", lastWorkingAt: 1 },
      recent: { age: "recent", lastWorkingAt: 30 },
      idle: { age: "inactive", lastWorkingAt: 4 },
      errored: { age: "invalid", lastWorkingAt: 0 },
    }).flatMap((group) => group.rows);
    const parent = rows.findIndex((row) => row.session.id === "parent");
    expect(rows.slice(parent, parent + 4).map(({ session, depth }) => [session.id, depth])).toEqual(
      [
        ["parent", 0],
        ["idle", 1],
        ["unloaded", 1],
        ["errored", 0],
      ],
    );
    expect(rows.find((row) => row.session.id === "errored")?.depth).toBe(0);
  });

  it("groups idle trees by the parent's project, not the child's project", () => {
    const sessions = [
      { id: "b-parent", title: "B manager", project: "Zulu" },
      { id: "a-child", title: "A child", project: "Zulu", parentSessionId: "a-parent" },
      { id: "b-child", title: "B child", project: "Alpha", parentSessionId: "b-parent" },
      { id: "a-parent", title: "A manager", project: "Alpha" },
    ];
    const rows = layoutChatGPTSessions(sessions, [], "activity", {}).flatMap((group) => group.rows);
    expect(rows.map(({ session, depth }) => [session.id, depth])).toEqual([
      ["a-parent", 0],
      ["a-child", 1],
      ["b-parent", 0],
      ["b-child", 1],
    ]);
  });

  it("can place errors with project trees or float them to the bottom", () => {
    const sessions = [
      { id: "error-alpha", title: "Error", project: "Alpha" },
      { id: "idle-zulu", title: "Idle", project: "Zulu" },
      { id: "idle-alpha", title: "Manager", project: "Alpha" },
      { id: "error-child", title: "Error child", parentSessionId: "idle-alpha", project: "Zulu" },
    ];
    const activities = {
      "error-alpha": { age: "invalid" as const, lastWorkingAt: 0 },
      "idle-zulu": { age: "inactive" as const, lastWorkingAt: 0 },
      "idle-alpha": { age: "inactive" as const, lastWorkingAt: 0 },
      "error-child": { age: "interrupted" as const, lastWorkingAt: 0 },
    };
    const rows = (bottom: boolean) =>
      layoutChatGPTSessions(sessions, [], "activity", activities, [], undefined, bottom).flatMap((group) => group.rows);
    expect(rows(true).map(({ session }) => session.id)).toEqual([
      "idle-alpha",
      "idle-zulu",
      "error-alpha",
      "error-child",
    ]);
    expect(rows(false).map(({ session, depth }) => [session.id, depth])).toEqual([
      ["error-alpha", 0],
      ["idle-alpha", 0],
      ["error-child", 1],
      ["idle-zulu", 0],
    ]);
  });

  it("always prioritizes working sessions, including over a selected idle manual chat", () => {
    const sessions = [
      { id: "working", title: "Wartribes worker" },
      { id: "legacy", title: "Unknown origin" },
      { id: "backend", title: "Backend worker", creationOrigin: "backend" as const },
      { id: "manual", title: "New manual chat", creationOrigin: "manual" as const },
      {
        id: "reserved",
        title: "Reserved worker",
        creationOrigin: "manual" as const,
        spawnRequestId: "backend-proof",
      },
    ];
    const activity = {
      working: { age: "working" as const, lastWorkingAt: 100 },
      legacy: { age: "inactive" as const, lastWorkingAt: 50 },
      backend: { age: "invalid" as const, lastWorkingAt: 30 },
      manual: { age: "invalid" as const, lastWorkingAt: 20 },
      reserved: { age: "invalid" as const, lastWorkingAt: 10 },
    };
    const ids = (selected?: string) =>
      layoutChatGPTSessions(sessions, projects, "activity", activity, [], selected).flatMap(
        (group) => group.rows.map(({ session }) => session.id),
      );
    expect(ids("manual")).toEqual(["working", "legacy", "backend", "manual", "reserved"]);
    expect(ids()).toEqual(["working", "legacy", "backend", "manual", "reserved"]);
    expect(ids("legacy")).toEqual(ids());
    expect(ids("backend")).toEqual(ids());
    expect(ids("reserved")).toEqual(ids());
    expect(layoutChatGPTSessions(sessions, projects, "started", activity, [], "manual")).toEqual(
      groupChatGPTSessions(sessions, projects),
    );
  });
  it("treats status-unknown chats as inactive and preserves stable tie ordering", () => {
    const actual = layoutChatGPTSessions(
      [
        { id: "first", title: "Cascadeur first" },
        { id: "second", title: "Cascadeur second" },
        { id: "third", title: "Cascadeur third" },
        { id: "fourth", title: "Cascadeur fourth" },
      ],
      [],
      "activity",
      {
        first: { age: "recent", lastWorkingAt: 10 },
        second: { age: "recent", lastWorkingAt: 10 },
      },
    );
    expect(actual.flatMap((group) => group.rows.map(({ session }) => session.id))).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });
});
