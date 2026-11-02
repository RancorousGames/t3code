// @effect-diagnostics nodeBuiltinImport:off -- Electron MAIN scans local TaskBoard Markdown, never renderer paths.
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";
import { boardRoots } from "./taskBoardHumanInboxIpc.ts";

export interface TaskBoardClaim {
  taskId: string;
  claimedBy: string;
  column: string;
  boardRoot?: string;
  project?: string;
  withMe?: boolean;
  laterUntil?: string;
  completedAt: number | null;
  handoffAt: number | null;
  liveState: "ready" | "in_session" | null;
  taskTitle?: string;
  liveBrief?: string;
  liveEstMinutes?: number;
  liveReadyAt?: string;
}

const DEFAULT_VAULT = "B:/GDrive/SharedWithPhone/Obsidian/jjj";

/** Read only frontmatter. An unclaimed task still matters if its ID appears in
 * a worker title; legacy claim labels may use short UUIDs instead of exact ones.
 * No prose/AI Notes are interpreted as evidence of completion.
 */
export function parseTaskBoardClaim(contents: string): TaskBoardClaim | null {
  if (!contents.startsWith("---\n") && !contents.startsWith("---\r\n")) return null;
  const end = contents.indexOf("\n---", 4);
  if (end < 0 || end > 16_384) return null;
  const header = contents.slice(0, end);
  const read = (key: string) => {
    const line = header.split(/\r?\n/).find((row) => row.startsWith(`${key}:`));
    return (line?.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, "") ?? "");
  };
  const claimedBy = read("claimed_by");
  const taskId = read("id");
  const column = read("column").toLowerCase();
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(taskId) || !column) return null;
  const completedAt = Date.parse(read("completed_at"));
  const liveBlock = header.match(/^live:\s*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*)/m)?.[1] ?? "";
  const liveState = liveBlock.match(/^\s+state:\s*(ready|in_session)\s*$/m)?.[1] ?? null;
  const withMe = /^\s+with_me:\s*true\s*$/m.test(liveBlock);
  const laterUntil = liveBlock.match(/^\s+later_until:\s*(\S+)\s*$/m)?.[1]?.replace(/^["\u0027]|["\u0027]$/g, "");
  const title = read("title");
  const brief = liveBlock.match(/^\s+brief:\s*(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const estimated = Number(liveBlock.match(/^\s+est_minutes:\s*(\d+)\s*$/m)?.[1]);
  const readyAt = liveBlock.match(/^\s+ready_at:\s*(\S+)\s*$/m)?.[1];
  return {
    taskId,
    claimedBy: claimedBy.toLowerCase(),
    column,
    completedAt: Number.isFinite(completedAt) ? completedAt : null,
    handoffAt: null,
    liveState: liveState === "ready" || liveState === "in_session" ? liveState : null,
    ...(withMe ? { withMe: true } : {}),
    ...(laterUntil && laterUntil !== "null" ? { laterUntil } : {}),
    ...(title ? { taskTitle: title } : {}),
    ...(brief ? { liveBrief: brief } : {}),
    ...(Number.isFinite(estimated) && estimated > 0 ? { liveEstMinutes: estimated } : {}),
    ...(readyAt ? { liveReadyAt: readyAt } : {}),
  };
}

/** A read error never proves a worker has no tasks: propagate it to skip cleanup. */
export async function readTaskBoardClaims(
  vault = NodeProcess.env.T3_TASKBOARD_VAULT ?? DEFAULT_VAULT,
): Promise<TaskBoardClaim[]> {
  // The registered TaskBoard catalog contains boards outside the Obsidian
  // vault as well. A manually supplied vault (unit fixtures) stays isolated.
  const boards = vault === DEFAULT_VAULT
    ? await boardRoots(vault)
    : (await NodeFS.readdir(vault, { withFileTypes: true }))
      .filter((project) => project.isDirectory() && !project.name.startsWith("."))
      .map((project) => NodePath.join(vault, project.name, "Tasks"));
  const claims: TaskBoardClaim[] = [];
  for (const board of boards) {
    const projectName = NodePath.basename(NodePath.dirname(board));
    const active = NodePath.join(board, "Active");
    let entries;
    try {
      entries = await NodeFS.readdir(active, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const projectClaims: TaskBoardClaim[] = [];
    const relatedForUser = new Map<string, number>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = NodePath.join(active, entry.name);
      const info = await NodeFS.stat(file);
      // An unreadable/oversized task could hide a worker association; don't
      // infer "unassigned" from a silently skipped card.
      if (info.size > 128 * 1024) throw new Error(`Oversized TaskBoard card: ${file}`);
      const contents = await NodeFS.readFile(file, "utf8");
      const claim = parseTaskBoardClaim(contents);
      if (!claim) throw new Error(`Unparseable TaskBoard frontmatter: ${file}`);
      claim.boardRoot = board;
      claim.project = projectName;
      projectClaims.push(claim);
      const header = contents.split(/\r?\n---(?:\r?\n|$)/, 2)[0] ?? "";
      const pendingAttention = /^attention:\s*$/m.test(header) &&
        /^\s*-\s*(?:question|needs-user)\s*$/m.test(header);
      const answer = header.match(/^  answer:\s*(.*)$/m)?.[1]?.trim();
      const unanswered = !answer || answer === "null" || answer === "~";
      const hasQuestion = /^question:\s*$/m.test(header) && /^  prompt:\s*\S/m.test(header);
      const awaitingHuman = pendingAttention && hasQuestion && unanswered &&
        !/^column:\s*(?:draft|done)\s*$/m.test(header);
      // A question on the worker's own claimed task is a handoff; use the
      // read file mtime as a conservative clock when no request timestamp exists.
      if (awaitingHuman) claim.handoffAt = info.mtimeMs;
      // Separate For User cards only affect explicit related_to task IDs.
      if (awaitingHuman && (/^kind:\s*for_user\s*$/m.test(header) ||
          /^\s*-\s*needs-user\s*$/m.test(header))) {
        const matches = header.match(/^related_to:\s*\r?\n((?:\s*-\s*[A-Z][A-Z0-9]*-\d+\s*\r?\n?)*)/m);
        for (const id of matches?.[1]?.match(/[A-Z][A-Z0-9]*-\d+/g) ?? [])
          relatedForUser.set(id, Math.max(relatedForUser.get(id) ?? 0, info.mtimeMs));
      }
    }
    for (const claim of projectClaims) {
      const manifestPath = NodePath.join(board, "Reviews", claim.taskId, "manifest.json");
      try {
        const manifest = JSON.parse(await NodeFS.readFile(manifestPath, "utf8")) as {
          task_id?: string; status?: string; rounds?: Array<{ requested_at?: string }>;
        };
        if (manifest.task_id !== claim.taskId) throw new Error("Review identity mismatch: " + manifestPath);
        if (manifest.status === "open") {
          const requested = Date.parse(manifest.rounds?.at(-1)?.requested_at ?? "");
          if (!Number.isFinite(requested)) throw new Error("Invalid review timestamp: " + manifestPath);
          claim.handoffAt = requested;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (claim.handoffAt === null && relatedForUser.has(claim.taskId))
        claim.handoffAt = relatedForUser.get(claim.taskId)!;
      claims.push(claim);
    }
  }
  return claims;
}

export const readTaskBoardWorkerClaimsIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TASKBOARD_WORKER_CLAIMS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(
    Schema.Struct({
      taskId: Schema.String,
      claimedBy: Schema.String,
      column: Schema.String,
      boardRoot: Schema.optional(Schema.String),
      project: Schema.optional(Schema.String),
      withMe: Schema.optional(Schema.Boolean),
      laterUntil: Schema.optional(Schema.String),
      completedAt: Schema.NullOr(Schema.Number),
      handoffAt: Schema.NullOr(Schema.Number),
      liveState: Schema.NullOr(Schema.Literals(["ready", "in_session"])),
      taskTitle: Schema.optional(Schema.String),
      liveBrief: Schema.optional(Schema.String),
      liveEstMinutes: Schema.optional(Schema.Number),
      liveReadyAt: Schema.optional(Schema.String),
    }),
  ),
  handler: Effect.fn("desktop.ipc.taskBoardWorkerClaims")(function* () {
    return yield* Effect.promise(() => readTaskBoardClaims());
  }),
});
