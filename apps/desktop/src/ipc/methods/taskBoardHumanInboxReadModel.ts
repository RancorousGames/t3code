// @effect-diagnostics nodeBuiltinImport:off -- local Electron MAIN reads TaskBoard through its canonical CLI.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DEFAULT_TASKBOARD_CLI =
  "D:/SSDProjects/Tools/TaskBoard/src-tauri/target/release/taskboard.exe";

/** An exact source identity; never deduplicate by short task ID across boards. */
export function taskBoardSourceKey(boardRoot: string, taskId: string): string {
  const normalized = NodePath.win32
    .normalize(boardRoot.replace(/\//g, "\\"))
    .replace(/[\\]+$/u, "")
    .toLowerCase();
  return JSON.stringify(["taskboard", normalized, taskId]);
}

export type HumanInboxSourceStatus = "available" | "unavailable";

export interface TaskBoardInboxTask {
  id: string;
  title: string;
  kind: string;
  column: string;
  archived?: boolean;
  completed?: string | null;
  attention?: string[];
  question?: { prompt: string; answer?: string | null } | null;
  depends_on?: string[];
  review_status?: "open" | "resolved" | null;
  review_round?: number | null;
  created?: string;
  path?: string;
  description?: string;
}

export interface TaskBoardInboxSnapshot {
  boardRoot: string;
  tasks: TaskBoardInboxTask[];
  columns: Array<{ id: string; terminal: boolean }>;
}

/** A foreign-source projection, NOT another answer/approval/claim store. */
export interface UnifiedHumanInboxEntry {
  sourceKey: string;
  source: "taskboard" | "openrig";
  sourceId: string;
  boardRoot?: string;
  title: string;
  body?: string;
  createdAt?: string;
  state: string;
  requiresAction: boolean;
  /** A native TaskBoard Review must still be opened/resolved in TaskBoard. */
  review?: { taskId: string; boardRoot: string; round: number | null };
  /** A source-file link only; not falsely advertised as a native Review deep link. */
  sourceUrl?: string;
  /** The source's OWN answer endpoint, never inferred from a display flag. */
  replySupported: boolean;
}

export interface UnifiedHumanInboxReadModel {
  items: UnifiedHumanInboxEntry[];
  sources: Array<{
    source: "taskboard" | "openrig";
    id: string;
    status: HumanInboxSourceStatus;
    error?: string;
  }>;
}

/** Match TaskBoard's native eligibility: terminal/completed/archived and prerequisites exclude attention. */
export function taskBoardPendingEntries(
  snapshot: TaskBoardInboxSnapshot,
): UnifiedHumanInboxEntry[] {
  const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const terminal = new Set(
    snapshot.columns.filter((column) => column.terminal).map((column) => column.id),
  );
  const complete = (task: TaskBoardInboxTask) =>
    !!task.archived || !!task.completed || terminal.has(task.column);
  const result: UnifiedHumanInboxEntry[] = [];
  const seen = new Set<string>();

  for (const task of snapshot.tasks) {
    if (!task.id || !task.title || task.archived) continue;
    const openReview = task.review_status === "open";
    const pendingQuestion =
      !complete(task) && (task.kind === "for_user" || task.attention?.includes("needs-user"));
    if (!pendingQuestion && !openReview) continue;
    // Native Review remains visible while open, even when its task is Done.
    if (pendingQuestion && !openReview &&
      !(task.depends_on ?? []).every((id) => {
        const dependency = byId.get(id);
        return dependency !== undefined && complete(dependency);
      })) continue;

    const sourceKey = taskBoardSourceKey(snapshot.boardRoot, task.id);
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    result.push({
      sourceKey,
      source: "taskboard",
      sourceId: task.id,
      boardRoot: snapshot.boardRoot,
      title: task.title,
      body: task.question?.prompt || task.description || "Open this item in TaskBoard to review.",
      ...(task.created ? { createdAt: task.created } : {}),
      state: "pending", // Projected only from the source task; never an approval or local snooze.
      requiresAction: true,
      ...(openReview
        ? {
            review: {
              taskId: task.id,
              boardRoot: snapshot.boardRoot,
              round: task.review_round ?? null,
            },
          }
        : {}),
      ...(task.path ? { sourceUrl: NodeURL.pathToFileURL(task.path).href } : {}),
      replySupported: false, // TaskBoard has no acknowledged T3 answer API.
    });
  }
  return result;
}

export type OperatorInboxProjection = {
  available: boolean;
  reason?: string;
  address: string;
  items: Array<{
    id: string;
    sourceType: string;
    subject: string;
    state: string;
    requiresAction: boolean;
    replyEligible?: boolean;
    recipient?: string;
  }>;
};

/**
 * Read-only merge. OpenRig items preserve their own IDs/states and direct reply
 * eligibility. No OpenRig gate is conflated with a TaskBoard review for the same
 * topic; they are separate source obligations unless a canonical link says otherwise.
 */
export function mergeHumanInboxReadModels(
  boards: ReadonlyArray<{ boardRoot: string; snapshot?: TaskBoardInboxSnapshot; error?: string }>,
  openrig: OperatorInboxProjection,
): UnifiedHumanInboxReadModel {
  const items: UnifiedHumanInboxEntry[] = [];
  const sources: UnifiedHumanInboxReadModel["sources"] = [];
  const keys = new Set<string>();
  for (const board of boards) {
    sources.push({
      source: "taskboard",
      id: board.boardRoot,
      status: board.snapshot ? "available" : "unavailable",
      ...(!board.snapshot ? { error: board.error ?? "TaskBoard source unavailable" } : {}),
    });
    if (!board.snapshot) continue;
    for (const item of taskBoardPendingEntries(board.snapshot)) {
      if (keys.has(item.sourceKey)) continue;
      keys.add(item.sourceKey);
      items.push(item);
    }
  }
  sources.push({
    source: "openrig",
    id: openrig.address,
    status: openrig.available ? "available" : "unavailable",
    ...(!openrig.available ? { error: openrig.reason ?? "OpenRig source unavailable" } : {}),
  });
  if (openrig.available) {
    for (const item of openrig.items) {
      const sourceKey = JSON.stringify(["openrig", openrig.address, item.sourceType, item.id]);
      if (keys.has(sourceKey)) continue;
      keys.add(sourceKey);
      items.push({
        sourceKey,
        source: "openrig",
        sourceId: item.id,
        title: item.subject,
        state: item.state,
        requiresAction: item.requiresAction,
        replySupported:
          item.sourceType === "queue" &&
          item.replyEligible === true &&
          item.recipient === openrig.address,
      });
    }
  }
  return { items, sources };
}

/**
 * Optional T3 MAIN backend adapter: use TaskBoard's actual structured CLI, not
 * duplicate YAML interpretation or any answer/review mutation. Each failure is
 * returned per source; it must not turn an offline board into an empty inbox.
 */
export async function readTaskBoardInboxBoards(
  boardRoots: readonly string[],
  cli = process.env.T3_TASKBOARD_CLI ?? DEFAULT_TASKBOARD_CLI,
  execute: (exe: string, argv: string[]) => Promise<string> = async (exe, argv) => {
    const { stdout } = await execFile(exe, argv, {
      windowsHide: true,
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 8_000_000,
    });
    return stdout;
  },
): Promise<Array<{ boardRoot: string; snapshot?: TaskBoardInboxSnapshot; error?: string }>> {
  const unique = new Map<string, string>();
  for (const root of boardRoots.slice(0, 30)) {
    if (typeof root !== "string" || !NodePath.win32.isAbsolute(root)) continue;
    unique.set(taskBoardSourceKey(root, ""), root);
  }
  return Promise.all(
    [...unique.values()].map(async (boardRoot) => {
      try {
        const [taskJson, columnJson] = await Promise.all([
          execute(cli, ["task", "list", "--json", "--root", boardRoot]),
          execute(cli, ["column", "list", "--json", "--root", boardRoot]),
        ]);
        const taskResult: unknown = JSON.parse(taskJson);
        const columnResult: unknown = JSON.parse(columnJson);
        if (
          !taskResult ||
          typeof taskResult !== "object" ||
          !("tasks" in taskResult) ||
          !Array.isArray(taskResult.tasks) ||
          !columnResult ||
          typeof columnResult !== "object" ||
          !("columns" in columnResult) ||
          !Array.isArray(columnResult.columns)
        )
          throw new Error("TaskBoard returned an invalid structured snapshot");
        const tasks = taskResult.tasks as TaskBoardInboxTask[];
        // Review verdict/status belongs to the native Review manifest, not a
        // task-frontmatter hint that may be stale after a concurrent resolve.
        for (const task of tasks.filter((item) => item.review_status === "open")) {
          const result: unknown = JSON.parse(
            await execute(cli, ["task", "review", "show", "--json", "--root", boardRoot, task.id]),
          );
          if (
            !result ||
            typeof result !== "object" ||
            !("review" in result) ||
            !result.review ||
            typeof result.review !== "object" ||
            !("task_id" in result.review) ||
            result.review.task_id !== task.id ||
            !("status" in result.review) ||
            !["open", "resolved"].includes(String(result.review.status))
          )
            throw new Error(`TaskBoard returned an invalid review manifest for ${task.id}`);
          task.review_status = result.review.status as "open" | "resolved";
          task.review_round =
            "current_round" in result.review && typeof result.review.current_round === "number"
              ? result.review.current_round
              : null;
        }
        return {
          boardRoot,
          snapshot: {
            boardRoot,
            tasks,
            columns: columnResult.columns as TaskBoardInboxSnapshot["columns"],
          },
        };
      } catch (error) {
        return { boardRoot, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}
