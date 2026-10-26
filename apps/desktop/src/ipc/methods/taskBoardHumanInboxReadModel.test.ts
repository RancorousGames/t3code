import { describe, expect, it } from "vite-plus/test";
import {
  mergeHumanInboxReadModels,
  readTaskBoardInboxBoards,
  taskBoardPendingEntries,
  taskBoardSourceKey,
  type TaskBoardInboxSnapshot,
} from "./taskBoardHumanInboxReadModel.ts";

const task = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: id,
  kind: "for_user",
  column: "for-user",
  archived: false,
  completed: null,
  depends_on: [],
  attention: [],
  question: { prompt: "Decision?", answer: null },
  path: `B:/Vault/Omni/Tasks/Active/${id}.md`,
  ...overrides,
});
const board = (boardRoot: string, tasks = [task("OMN-01")]): TaskBoardInboxSnapshot => ({
  boardRoot,
  columns: [
    { id: "done", terminal: true },
    { id: "for-user", terminal: false },
  ],
  tasks,
});

describe("OW-0022 TaskBoard read-only human inbox projection", () => {
  it("deduplicates review plus For User, but never joins equal IDs from different boards", () => {
    const first = board("B:/Vault/Omni/Tasks", [
      task("X-1", { review_status: "open", review_round: 2 }),
    ]);
    const other = board("b:\\Vault\\Else\\Tasks", [task("X-1")]);
    const merged = mergeHumanInboxReadModels(
      [
        { boardRoot: first.boardRoot, snapshot: first },
        { boardRoot: other.boardRoot, snapshot: other },
        { boardRoot: "B:\\Vault\\OMNI\\Tasks\\", snapshot: first },
      ],
      {
        address: "human@kernel",
        available: true,
        items: [
          {
            id: "X-1",
            sourceType: "queue",
            subject: "Other source",
            state: "pending",
            requiresAction: true,
            replyEligible: false,
            recipient: "human@kernel",
          },
        ],
      },
    );
    expect(merged.items).toHaveLength(3);
    const review = merged.items.find((item) => item.review);
    expect(review).toMatchObject({
      source: "taskboard",
      sourceId: "X-1",
      replySupported: false,
      review: { taskId: "X-1", round: 2 },
    });
    expect(review?.sourceUrl).toContain("X-1.md");
    expect(taskBoardSourceKey("B:/Vault/Omni/Tasks", "X-1")).toBe(
      taskBoardSourceKey("b:\\vault\\OMNI\\Tasks\\", "X-1"),
    );
  });

  it("keeps unresolved dependencies, terminal tasks, archived tasks and answered cards out", () => {
    expect(
      taskBoardPendingEntries(
        board("B:/Vault/Omni/Tasks", [
          task("X-1", { depends_on: ["X-2"] }),
          task("X-2", { kind: "task", column: "for-user" }),
          task("X-3", { column: "done" }),
          task("X-4", { archived: true }),
          task("X-5", { question: { prompt: "Answered", answer: "Done" } }),
          task("X-6", { review_status: "open", kind: "task", question: null }),
          task("X-7", { review_status: "resolved", kind: "task", question: null }),
        ]),
      ).map((item) => item.sourceId),
    ).toEqual(["X-6"]);
  });

  it("does not convert unavailable sources into zero source-owned tasks or approvals", () => {
    const merged = mergeHumanInboxReadModels(
      [{ boardRoot: "B:/offline/Tasks", error: "drive unavailable" }],
      { available: false, reason: "daemon offline", address: "human@kernel", items: [] },
    );
    expect(merged.items).toEqual([]);
    expect(merged.sources).toEqual([
      {
        source: "taskboard",
        id: "B:/offline/Tasks",
        status: "unavailable",
        error: "drive unavailable",
      },
      { source: "openrig", id: "human@kernel", status: "unavailable", error: "daemon offline" },
    ]);
  });

  it("reconciles the native Review manifest instead of trusting stale task hints", async () => {
    const read = await readTaskBoardInboxBoards(
      ["B:/Vault/Omni/Tasks"],
      "taskboard.exe",
      async (_exe, argv) => {
        if (argv[0] === "column") return JSON.stringify({ columns: [] });
        if (argv[1] === "review")
          return JSON.stringify({
            review: { task_id: "R-1", status: "resolved", current_round: 3 },
          });
        return JSON.stringify({
          tasks: [
            task("R-1", {
              kind: "task",
              question: null,
              review_status: "open",
              review_round: 1,
            }),
          ],
        });
      },
    );
    expect(read[0]?.snapshot?.tasks[0]).toMatchObject({
      review_status: "resolved",
      review_round: 3,
    });
    expect(taskBoardPendingEntries(read[0]!.snapshot!)).toEqual([]);
  });

  it("uses TaskBoard's structured list/columns and keeps failed boards visible", async () => {
    const invoked: string[][] = [];
    const reads = await readTaskBoardInboxBoards(
      ["B:/Vault/Omni/Tasks", "B:/missing/Tasks"],
      "taskboard.exe",
      async (_exe, argv) => {
        invoked.push(argv);
        if (argv.at(-1) === "B:/missing/Tasks") throw new Error("source disconnected");
        return argv[0] === "task"
          ? JSON.stringify({ tasks: [task("OMN-01")] })
          : JSON.stringify({ columns: [{ id: "done", terminal: true }] });
      },
    );
    expect(invoked).toHaveLength(4);
    expect(reads[0]?.snapshot?.tasks[0]?.id).toBe("OMN-01");
    expect(reads[1]).toMatchObject({
      boardRoot: "B:/missing/Tasks",
      error: "source disconnected",
    });
  });
});
