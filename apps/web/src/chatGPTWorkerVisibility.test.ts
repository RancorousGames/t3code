import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./hooks/useLocalStorage";

import type { BrowserSession } from "./chatGPTBrowserSessions";
import { layoutChatGPTSessions } from "./chatGPTSessionGrouping";
import { searchChatGPTSessionGroups } from "./chatGPTSessionSearch";
import {
  chatGPTWorkerVisibilityStorageKey,
  filterChatGPTWorkerGroups,
  linkedChatGPTWorkerIds,
} from "./chatGPTWorkerVisibility";

const projects = [
  { id: "wartribes", title: "Wartribes", workspaceRoot: "D:/Wartribes" },
  { id: "t3", title: "T3 Code", workspaceRoot: "D:/SSDProjects/Tools/t3code" },
];

const sessions: BrowserSession[] = [
  { id: "manager", title: "Wartribes manager", project: "Wartribes" },
  { id: "child", title: "T3 Code work", parentSessionId: "manager", project: "T3 Code" },
  { id: "grandchild", title: "Review work", parentSessionId: "child" },
  { id: "manual", title: "Manually opened T3 Code", project: "T3 Code" },
  { id: "orphan", title: "Work left unlinked", parentSessionId: "lost-manager" },
  { id: "detached", title: "Detached work", parentSessionId: null },
];

const ids = (groups: ReturnType<typeof layoutChatGPTSessions>) =>
  groups.flatMap((group) => group.rows.map((row) => row.session.id));

describe("ChatGPT parent-linked worker visibility", () => {
  it("persists the view preference independently for each connected environment", () => {
    const first = chatGPTWorkerVisibilityStorageKey("server-a");
    const second = chatGPTWorkerVisibilityStorageKey("server-b");
    expect(first).not.toBe(second);
    try {
      setLocalStorageItem(first, false, Schema.Boolean);
      setLocalStorageItem(second, true, Schema.Boolean);
      expect(getLocalStorageItem(first, Schema.Boolean)).toBe(false);
      expect(getLocalStorageItem(second, Schema.Boolean)).toBe(true);
    } finally {
      removeLocalStorageItem(first);
      removeLocalStorageItem(second);
    }
  });

  it("filters only proven parent links, including descendants, not worker-like names or orphan references", () => {
    const workers = linkedChatGPTWorkerIds(sessions);
    expect([...workers]).toEqual(["child", "grandchild"]);
    expect(workers.has("manual")).toBe(false);
    expect(workers.has("orphan")).toBe(false);
    expect(workers.has("detached")).toBe(false);
    expect(workers.has("manager")).toBe(false);
  });

  it("leaves cyclic or absent parent links visible and does not guess from a title or project", () => {
    const corrupt: BrowserSession[] = [
      { id: "cycle-a", title: "Manager", parentSessionId: "cycle-b" },
      { id: "cycle-b", title: "Worker", parentSessionId: "cycle-a" },
      { id: "unlinked", title: "Worker assigned to manager project" },
    ];
    const workerIds = linkedChatGPTWorkerIds(corrupt);
    expect(workerIds.size).toBe(0);
  });

  it("keeps manager and manually opened sessions in original project groups and removes stale child counts", () => {
    const full = layoutChatGPTSessions(sessions, projects, "started", {});
    const workers = linkedChatGPTWorkerIds(sessions);
    const filtered = filterChatGPTWorkerGroups(full, workers, false, new Set());
    const expectedIds = ["manager", "manual", "orphan", "detached"];
    expect(ids(filtered).sort()).toEqual(expectedIds.sort());
    const managerBefore = full
      .flatMap((group) => group.rows)
      .find((row) => row.session.id === "manager");
    const managerAfter = filtered
      .flatMap((group) => group.rows)
      .find((row) => row.session.id === "manager");
    expect(managerBefore?.childCount).toBe(1);
    expect(managerAfter).toMatchObject({ depth: 0, childCount: 0 });
    expect(full.find((group) => group.rows.some((row) => row.session.id === "manager"))?.key).toBe(
      filtered.find((group) => group.rows.some((row) => row.session.id === "manager"))?.key,
    );
    expect(sessions[1]?.parentSessionId).toBe("manager");
    expect(sessions[1]?.hidden).toBeUndefined();
  });

  it("supports reversing the filter and searching only actually displayed rows", () => {
    const full = layoutChatGPTSessions(sessions, projects, "activity", {
      child: { age: "working", lastWorkingAt: 100 },
      manager: { age: "inactive", lastWorkingAt: 10 },
    });
    const workerIds = linkedChatGPTWorkerIds(sessions);
    const filtered = filterChatGPTWorkerGroups(full, workerIds, false, new Set());
    expect(ids(searchChatGPTSessionGroups(filtered, "Review work"))).toEqual([]);
    expect(ids(searchChatGPTSessionGroups(filtered, "manager"))).toEqual(["manager"]);
    expect(filterChatGPTWorkerGroups(full, workerIds, true, new Set())).toEqual(full);
    expect(ids(filterChatGPTWorkerGroups(full, workerIds, true, new Set()))).toContain(
      "grandchild",
    );
    expect(sessions.map((session) => session.hidden)).toEqual(Array(6).fill(undefined));
  });

  it("retains empty permanent project drop targets while removing other empty worker groups", () => {
    const full = [
      { key: "permanent", title: "Pinned", rows: [] },
      {
        key: "worker-only",
        title: "Workers",
        rows: [
          {
            session: sessions[1]!,
            depth: 0,
            childCount: 1,
          },
        ],
      },
    ];
    expect(
      filterChatGPTWorkerGroups(full, new Set(["child"]), false, new Set(["permanent"])),
    ).toEqual([{ key: "permanent", title: "Pinned", rows: [] }]);
  });
});

describe("verified manager seats are never filtered as subordinate workers", () => {
  const lineage: BrowserSession[] = [
    { id: "omni", title: "Omni Coordinator", project: "Omni" },
    { id: "t3-manager", title: "T3 Code Manager", parentSessionId: "omni", project: "T3 Code" },
    { id: "t3-worker", title: "T3 source specialist", parentSessionId: "t3-manager" },
    { id: "wartribes-manager", title: "Wartribes Manager", parentSessionId: "omni" },
    { id: "rig-manager", title: "RIG MANAGER", parentSessionId: "omni" },
    { id: "omni-worker", title: "Coordinator worker", parentSessionId: "omni" },
    { id: "new-manager", title: "Renamed seat", parentSessionId: "t3-manager" },
    { id: "new-worker", title: "Nested worker", parentSessionId: "new-manager" },
    { id: "unknown-orphan", title: "Unknown class", parentSessionId: "not-present" },
    { id: "unknown-root", title: "T3 Code Manager (unverified)", project: "T3 Code" },
    { id: "hidden-worker", title: "Hidden worker", parentSessionId: "t3-manager", hidden: true },
    {
      id: "snoozed-worker",
      title: "Snoozed worker",
      parentSessionId: "t3-manager",
      snoozedUntil: Date.now() + 300_000,
    },
    { id: "hidden-manager", title: "Hidden manager", parentSessionId: "omni", hidden: true },
  ];

  const verifiedManagers = new Set([
    "omni",
    "t3-manager",
    "wartribes-manager",
    "rig-manager",
    "new-manager",
    "hidden-manager",
  ]);

  it("protects every verified manager at any lineage depth, independent of title", () => {
    const workers = linkedChatGPTWorkerIds(lineage, verifiedManagers);
    expect([...workers].sort()).toEqual(
      ["t3-worker", "omni-worker", "new-worker", "hidden-worker", "snoozed-worker"].sort(),
    );
    for (const id of verifiedManagers) expect(workers.has(id)).toBe(false);
    expect(workers.has("unknown-orphan")).toBe(false);
    expect(workers.has("unknown-root")).toBe(false);
    expect(lineage.find((s) => s.id === "t3-manager")?.parentSessionId).toBe("omni");
  });

  it("keeps verified manager siblings while hiding worker children in their original groups", () => {
    const visible = lineage.filter((entry) => !entry.hidden && !entry.snoozedUntil);
    const full = layoutChatGPTSessions(visible, projects, "started", {});
    const workers = linkedChatGPTWorkerIds(lineage, verifiedManagers);
    const filtered = filterChatGPTWorkerGroups(full, workers, false, new Set());
    expect(ids(filtered).sort()).toEqual(
      [
        "omni",
        "t3-manager",
        "wartribes-manager",
        "rig-manager",
        "new-manager",
        "unknown-orphan",
        "unknown-root",
      ].sort(),
    );
    expect(ids(filtered)).not.toContain("t3-worker");
    expect(ids(filtered)).not.toContain("new-worker");
    // Filtering is presentation-only: the authoritative parent, project and
    // existing persisted hidden/snoozed fields must not be modified.
    expect(lineage.find((entry) => entry.id === "t3-worker")?.parentSessionId).toBe("t3-manager");
    expect(lineage.find((entry) => entry.id === "hidden-worker")?.hidden).toBe(true);
    expect(lineage.find((entry) => entry.id === "snoozed-worker")?.snoozedUntil).toBeGreaterThan(
      Date.now(),
    );
    expect(filterChatGPTWorkerGroups(full, workers, true, new Set())).toEqual(full);
  });

  it("shows hidden verified managers in the hidden view without restoring hidden workers", () => {
    const hidden = lineage.filter((entry) => entry.hidden === true);
    const full = layoutChatGPTSessions(hidden, projects, "started", {});
    const workers = linkedChatGPTWorkerIds(lineage, verifiedManagers);
    expect(ids(filterChatGPTWorkerGroups(full, workers, false, new Set()))).toEqual([
      "hidden-manager",
    ]);
    // The sidebar deliberately bypasses the worker filter when showing hidden sessions.
    expect(filterChatGPTWorkerGroups(full, workers, true, new Set())).toEqual(full);
  });

  it("fails open when authoritative manager seat evidence is unavailable", () => {
    // Parent links alone cannot discriminate a T3 manager under Omni from
    // workers. Until the seat ledger is verified, do not suppress any row.
    const workers = linkedChatGPTWorkerIds(lineage, null);
    expect(workers.size).toBe(0);
    const displayed = lineage.filter((entry) => !entry.hidden && !entry.snoozedUntil);
    const full = layoutChatGPTSessions(displayed, projects, "started", {});
    expect(filterChatGPTWorkerGroups(full, workers, false, new Set())).toEqual(full);
    expect(ids(full)).toContain("t3-manager");
    expect(ids(full)).toContain("t3-worker");
  });

  it("does not promote a manager-like name without verified seat provenance", () => {
    const fake: BrowserSession[] = [
      { id: "parent", title: "Omni Coordinator" },
      { id: "unverified", title: "T3 Code Manager", parentSessionId: "parent" },
      { id: "orphan", title: "Worker", parentSessionId: "missing" },
    ];
    const workers = linkedChatGPTWorkerIds(fake, new Set(["parent"]));
    expect([...workers]).toEqual(["unverified"]);
    expect(workers.has("orphan")).toBe(false);
    // A display title does not authorize manager-role inference; missing
    // ledger evidence is a provenance limitation, not a reason to invent a role.
  });
});
