// @effect-diagnostics nodeBuiltinImport:off -- Path normalization is the behavior under test.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { boardOwnersFromSessions, compareQueuedCandidates, completedQueueTask } from "./TaskBoardWorkCoordinator.ts";

const WT = "B:\\GDrive\\Test\\Wartribes\\Tasks";
const T3 = "B:\\GDrive\\Test\\t3code\\Tasks";
const root = (path: string) => NodePath.resolve(path).toLowerCase();
const now = Date.parse("2026-11-14T00:30:00Z");
const task = (boardRoot: string, taskId: string, created: string,
  priority: "routine" | "urgent" = "routine",
  projectPriority: "high" | "normal" | "low" = "normal") => ({
    boardRoot, projectPriority, item: { taskId, created, priority },
  });

describe("TaskBoard Keep Busy selection", () => {
  it("counts Done queue tasks after the worker session closes, but never unrelated queue runs", () => {
    const at = "2026-11-14T05:40:40.060677200Z";
    const frontmatter = [
      "---", "id: REA-0029", "column: done", "queue_state: completed",
      "queue_request: stable-queue-request", "execution_mode: queue",
      `completed_at: ${at}`, "---",
    ].join("\n");
    const closed = {
      state: "completed" as const,
      queueRequest: "stable-queue-request",
      legacyOpenRig: false,
    };
    expect(completedQueueTask(closed, frontmatter)).toEqual({ at: Date.parse(at), stamp: at });
    expect(completedQueueTask({ ...closed, queueRequest: "new-run" }, frontmatter)).toBeNull();
    expect(completedQueueTask({ ...closed, state: "working" }, frontmatter)).toBeNull();
    expect(completedQueueTask(closed, frontmatter.replace("column: done", "column: in_progress")))
      .toBeNull();
    expect(completedQueueTask(closed, frontmatter.replace("execution_mode: queue", "execution_mode: manual")))
      .toBeNull();
  });

  it("gives ! Priority global precedence, then balances projects, then prefers fresh cards and numeric IDs", () => {
    const load = new Map([[root(WT), 3], [root(T3), 0]]);
    // An urgent task beats even an empty project and a high-priority project.
    expect(compareQueuedCandidates(
      task(WT, "WT-0500", "2026-01-01", "urgent"),
      task(T3, "T3-0001", "2026-11-14", "routine", "high"), load, now,
    )).toBeLessThan(0);
    // Within the same urgency, project balance outranks project preference.
    expect(compareQueuedCandidates(
      task(T3, "T3-0200", "2026-01-01", "urgent", "low"),
      task(WT, "WT-0001", "2026-11-14", "urgent", "high"), load, now,
    )).toBeLessThan(0);
    const equalLoad = new Map([[root(WT), 1], [root(T3), 1]]);
    expect(compareQueuedCandidates(
      task(WT, "WT-0001", "2026-01-01", "routine", "low"),
      task(T3, "T3-0200", "2026-01-01", "routine", "high"), equalLoad, now,
    )).toBeGreaterThan(0);
    // Date-only creation is eligible if its day overlaps the last 24h.
    expect(compareQueuedCandidates(
      task(WT, "WT-0100", "2026-11-13"),
      task(WT, "WT-0001", "2026-11-11"), equalLoad, now,
    )).toBeLessThan(0);
    // Age within the same freshness tier is irrelevant; compare numeric suffix.
    expect(compareQueuedCandidates(
      task(WT, "WT-0009", "2026-09-01"),
      task(WT, "WT-0010", "2026-01-01"), equalLoad, now,
    )).toBeLessThan(0);
  });

  it("counts manual task workers via binding or unique project identity", () => {
    const boards = [
      { boardRoot: WT, projectName: "Wartribes", projectId: "wartribes" },
      { boardRoot: T3, projectName: "t3code", projectId: "t3code" },
    ];
    const owners = boardOwnersFromSessions(boards, [
      { id: "manual", project: "WARTRIBES" },
      { id: "explicit", project: "t3code", binding: { taskRef: { board: WT } } },
      { id: "unbound", project: "unknown" },
      { id: "other", binding: { taskRef: { board: T3 } } },
    ]);
    expect(owners.get("manual")).toBe(root(WT));
    expect(owners.get("explicit")).toBe(root(WT));
    expect(owners.get("other")).toBe(root(T3));
    expect(owners.has("unbound")).toBe(false);
  });
});
