import { describe, expect, it } from "vite-plus/test";
import { completedWorkerCandidate } from "./chatGPTCompletedWorkerPolicy";
import type { BrowserSession } from "./chatGPTBrowserSessions";

const now = Date.parse("2026-10-25T15:00:00Z");
const manager = { id: "manager", title: "Coordinator" } satisfies BrowserSession;
const worker = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Worker",
  parentSessionId: "manager",
  spawnRequestId: "spawn-1",
} satisfies BrowserSession;
const done = {
  taskId: "T3-0073",
  claimedBy: worker.id,
  column: "done",
  completedAt: now - 31 * 60_000,
};
const check = (
  candidate: BrowserSession,
  tasks = [done],
  sessions: BrowserSession[] = [manager, candidate],
  selected?: string,
  at = now,
  managers: ReadonlySet<string> | null = new Set(["manager"]),
) => completedWorkerCandidate(sessions, candidate, tasks, managers, selected, at);

describe("TaskBoard-completed worker auto-close eligibility", () => {
  it("closes an exact claimed worker 30 minutes after Done, not before", () => {
    expect(check(worker)).toMatchObject({ taskIds: ["T3-0073"] });
    expect(check(worker, [{ ...done, completedAt: now - 29 * 60_000 }])).toBeNull();
    expect(check(worker, [{ ...done, column: "in-progress" }])).toBeNull();
    expect(check(worker, [])).toBeNull();
    expect(check(worker, [{ ...done, claimedBy: "other" }])).toBeNull();
  });

  it("waits for all claimed tasks and never closes roots, managers or parents", () => {
    expect(check(worker, [done, { ...done, taskId: "T3-0074", column: "blocked" }])).toBeNull();
    expect(
      check(
        worker,
        [done],
        [manager, worker, { id: "child", title: "Child", parentSessionId: worker.id }],
      ),
    ).toBeNull();
    expect(check(worker, [done], [worker])).toBeNull();
    expect(check(worker, [done], [manager, worker], undefined, now, null)).toBeNull();
    expect(
      check(worker, [done], [manager, worker], undefined, now, new Set([worker.id])),
    ).toBeNull();
    expect(check({ ...worker, title: "Wartribes Manager" })).toBeNull();
    // Legacy workers may lack a spawn request ID but still have a verified parent and exact task claim.
    expect(check({ ...worker, spawnRequestId: undefined })).not.toBeNull();
  });

  it("never auto-closes snoozed or bordered workers, including sticky historic exemptions", () => {
    for (const props of [
      { autoCloseExempt: true },
      { snoozedUntil: now - 100_000 },
      { snoozedUntil: now + 100_000 },
      { borderColor: "blue" },
      { hidden: true },
    ])
      expect(check({ ...worker, ...props })).toBeNull();
  });

  it("resetting direct interaction gives two hours and selected sessions never close", () => {
    expect(check({ ...worker, lastDirectInteractionAt: now - 60_000 })).toBeNull();
    expect(check({ ...worker, lastDirectInteractionAt: now - 121 * 60_000 })).toBeNull();
    expect(
      check({ ...worker, lastDirectInteractionAt: now - 121 * 60_000 }, [
        { ...done, completedAt: now - 121 * 60_000 },
      ]),
    ).not.toBeNull();
    expect(check(worker, [done], [manager, worker], worker.id)).toBeNull();
  });
});
