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
