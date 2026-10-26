import { describe, expect, it } from "vite-plus/test";
import {
  completedWorkerCandidate,
  WORKER_DONE_GRACE_MS,
  WORKER_MAX_AGE_MS,
  WORKER_UNASSIGNED_GRACE_MS,
} from "./chatGPTCompletedWorkerPolicy";
import type { BrowserSession } from "./chatGPTBrowserSessions";
import type { TaskBoardWorkerClaim } from "./chatGPTCompletedWorkerPolicy";

const now = Date.parse("2026-10-26T18:00:00Z");
const manager = { id: "manager", title: "Coordinator" } satisfies BrowserSession;
const worker = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "T3-0087 Human-Adopt Worker",
  parentSessionId: "manager",
  creationOrigin: "backend" as const,
  spawnRequestId: "spawn-1",
  createdAt: now - 3 * 60 * 60_000,
} satisfies BrowserSession;
const done: TaskBoardWorkerClaim = {
  taskId: "T3-0087",
  claimedBy: worker.id,
  column: "done",
  completedAt: now - 2 * 60 * 60_000 - 1,
};
const inProgress = { ...done, column: "in-progress", completedAt: null };
const check = (
  candidate: BrowserSession,
  tasks: TaskBoardWorkerClaim[] = [done],
  sessions: BrowserSession[] = [manager, candidate],
  selected?: string,
  at = now,
  managers: ReadonlySet<string> | null = new Set(["manager"]),
  evidence: { spawnCreatedAt?: number; lastWorkingAt?: number } = {},
) => completedWorkerCandidate(sessions, candidate, tasks, managers, selected, at, evidence);

describe("T3 verified worker lifecycle cleanup", () => {
  it("waits TWO HOURS after all associated TaskBoard tasks reach Done", () => {
    expect(WORKER_DONE_GRACE_MS).toBe(2 * 60 * 60_000);
    expect(check(worker)?.reason).toBe("all-tasks-done");
    expect(check(worker, [{ ...done, completedAt: now - WORKER_DONE_GRACE_MS + 1 }])).toBeNull();
    expect(check(worker, [done, inProgress])).toBeNull();
  });

  it("closes unassigned backend workers two hours after creation, never on mere idle", () => {
    expect(WORKER_UNASSIGNED_GRACE_MS).toBe(2 * 60 * 60_000);
    expect(check(worker, [])).toMatchObject({ taskIds: [], reason: "unassigned-two-hours" });
    expect(check({ ...worker, createdAt: now - 90 * 60_000 }, [])).toBeNull();
    expect(check({ ...worker, createdAt: undefined }, [])).toBeNull();
    expect(check(
      { ...worker, createdAt: undefined }, [], [manager, { ...worker, createdAt: undefined }],
      undefined, now, new Set(["manager"]), { spawnCreatedAt: now - 3 * 60 * 60_000 },
    )?.reason).toBe("unassigned-two-hours");
  });

  it("enforces a hard 24h cap even when associated task is In Progress", () => {
    expect(WORKER_MAX_AGE_MS).toBe(24 * 60 * 60_000);
    expect(check({ ...worker, createdAt: now - WORKER_MAX_AGE_MS }, [inProgress])?.reason)
      .toBe("worker-24-hours");
    expect(check({ ...worker, createdAt: now - WORKER_MAX_AGE_MS + 1 }, [inProgress]))
      .toBeNull();
    expect(check(
      { ...worker, createdAt: undefined },
      [inProgress],
      [manager, { ...worker, createdAt: undefined }],
      undefined,
      now,
      new Set(["manager"]),
      { lastWorkingAt: now - 26 * 60 * 60_000 },
    )?.reason).toBe("worker-24-hours");
  });

  it("uses the lavender role: backend provenance, NOT parent linkage or title", () => {
    expect(check({ ...worker, parentSessionId: undefined }, [])?.reason)
      .toBe("unassigned-two-hours");
    expect(check({ ...worker, creationOrigin: "manual", spawnRequestId: undefined }, []))
      .toBeNull();
    expect(check({ ...worker, creationOrigin: undefined, spawnRequestId: undefined }, []))
      .toBeNull();
    expect(check({ ...worker, humanControlled: true }, [])).toBeNull();
    expect(check(worker, [], [manager, worker], undefined, now, null)).toBeNull();
    expect(check(worker, [], [manager, worker], undefined, now, new Set([worker.id])))
      .toBeNull();
  });

  it("clicking or navigating does not exempt a worker, but human-adoption does", () => {
    expect(check({ ...worker, lastDirectInteractionAt: now - 1 }, [])?.reason)
      .toBe("unassigned-two-hours");
    expect(check({ ...worker, humanControlled: true }, [])).toBeNull();
    expect(check({ ...worker, autoCloseExempt: true }, [])).toBeNull();
  });

  it("never closes a snoozed, highlighted, manager, selected, hidden or parent worker", () => {
    for (const props of [
      { snoozedUntil: now - 10_000 },
      { snoozedUntil: now + 10_000 },
      { autoCloseExempt: true },
      { borderColor: "blue" },
      { hidden: true },
    ]) expect(check({ ...worker, ...props }, [])).toBeNull();
    expect(check({ ...worker, title: "T3 Manager" }, [])).toBeNull();
    expect(check(worker, [], [manager, worker], worker.id)).toBeNull();
    expect(check(
      worker, [],
      [manager, worker, { id: "child", title: "Other", parentSessionId: worker.id }],
    )).toBeNull();
    expect(check({ ...worker, parentSessionId: "nonexistent" }, [])).toBeNull();
  });

  it("recognizes legacy alias claims and title task IDs, even when not Done", () => {
    const legacy = { ...worker, title: "Collision Guard", createdAt: now - 3 * 60 * 60_000 };
    const aliases = [
      { taskId: "T3-0085", column: "in-progress", completedAt: null,
        claimedBy: "T3-worker-aaaaaaaa" },
    ];
    expect(check(legacy, aliases)).toBeNull();
    expect(check({ ...legacy, createdAt: now - 25 * 60 * 60_000 }, aliases)?.reason)
      .toBe("worker-24-hours");
    expect(check(worker, [{ ...inProgress, claimedBy: "" }])).toBeNull();
    expect(check(worker, [{ ...done, claimedBy: "T3 worker aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }])?.reason)
      .toBe("all-tasks-done");
  });
});
