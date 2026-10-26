// @effect-diagnostics nodeBuiltinImport:off -- Electron MAIN scans local TaskBoard Markdown, never renderer paths.
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export interface TaskBoardClaim {
  taskId: string;
  claimedBy: string;
  column: string;
  completedAt: number | null;
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
  return {
    taskId,
    claimedBy: claimedBy.toLowerCase(),
    column,
    completedAt: Number.isFinite(completedAt) ? completedAt : null,
  };
}

/** A read error never proves a worker has no tasks: propagate it to skip cleanup. */
export async function readTaskBoardClaims(
  vault = NodeProcess.env.T3_TASKBOARD_VAULT ?? DEFAULT_VAULT,
): Promise<TaskBoardClaim[]> {
  const projects = await NodeFS.readdir(vault, { withFileTypes: true });
  const claims: TaskBoardClaim[] = [];
  for (const project of projects) {
    if (!project.isDirectory() || project.name.startsWith(".")) continue;
    const active = NodePath.join(vault, project.name, "Tasks", "Active");
    let entries;
    try {
      entries = await NodeFS.readdir(active, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = NodePath.join(active, entry.name);
      const info = await NodeFS.stat(file);
      // An unreadable/oversized task could hide a worker association; don't
      // infer "unassigned" from a silently skipped card.
      if (info.size > 128 * 1024) throw new Error(`Oversized TaskBoard card: ${file}`);
      const claim = parseTaskBoardClaim(await NodeFS.readFile(file, "utf8"));
      if (!claim) throw new Error(`Unparseable TaskBoard frontmatter: ${file}`);
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
      completedAt: Schema.NullOr(Schema.Number),
    }),
  ),
  handler: Effect.fn("desktop.ipc.taskBoardWorkerClaims")(function* () {
    return yield* Effect.promise(() => readTaskBoardClaims());
  }),
});
