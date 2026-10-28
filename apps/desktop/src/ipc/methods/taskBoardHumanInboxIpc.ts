// @effect-diagnostics nodeBuiltinImport:off -- Electron MAIN reads the local TaskBoard catalog.
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";
import {
  mergeHumanInboxReadModels, readTaskBoardInboxBoards, taskBoardSourceKey,
} from "./taskBoardHumanInboxReadModel.ts";

const DEFAULT_VAULT = "B:/GDrive/SharedWithPhone/Obsidian/jjj";
const TASKBOARD_EXE = "D:/SSDProjects/Tools/TaskBoard/src-tauri/target/release/taskboard.exe";
const taskIdPattern = /^[A-Z][A-Z0-9]{1,11}-\d+$/u;

async function boardRoots(vault = NodeProcess.env.T3_TASKBOARD_VAULT ?? DEFAULT_VAULT) {
  const roots: string[] = [];
  const config = NodePath.join(NodeProcess.env.APPDATA ?? "", "TaskBoard", "projects.json");
  try {
    const catalog: unknown = JSON.parse(await NodeFS.readFile(config, "utf8"));
    if (catalog && typeof catalog === "object" && "projects" in catalog &&
        Array.isArray(catalog.projects))
      for (const project of catalog.projects)
        if (project && typeof project.path === "string") roots.push(project.path);
  } catch { /* Installed TaskBoard project catalog is optional; local boards remain discoverable. */ }
  try {
    for (const folder of await NodeFS.readdir(vault, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      const root = NodePath.join(vault, folder.name, "Tasks");
      try { await NodeFS.access(NodePath.join(root, "_board.md")); roots.push(root); }
      catch { /* Not a TaskBoard project. */ }
    }
  } catch {
    // Do not silently turn configured roots into an empty result if the vault is offline.
    if (!roots.length) roots.push(NodePath.join(vault, "Omniwork", "Tasks"));
  }
  return [...new Map(roots.map((root) => [taskBoardSourceKey(root, ""), root])).values()];
}

export async function readUnifiedTaskBoardItems() {
  const boards = await readTaskBoardInboxBoards(await boardRoots());
  const model = mergeHumanInboxReadModels(boards,
    { available: false, reason: "Read through existing OpenRig endpoint separately",
      address: "human@kernel", items: [] });
  return {
    items: model.items.filter((item): item is typeof item & { source: "taskboard" } => item.source === "taskboard"),
    sources: model.sources.filter((source): source is typeof source & { source: "taskboard" } => source.source === "taskboard"),
  };
}

const sourceSchema = Schema.Struct({
  source: Schema.Literal("taskboard"),
  id: Schema.String,
  status: Schema.Literals(["available", "unavailable"]),
  error: Schema.optional(Schema.String),
});
const itemSchema = Schema.Struct({
  source: Schema.Literal("taskboard"),
  sourceKey: Schema.String,
  sourceId: Schema.String,
  boardRoot: Schema.optional(Schema.String),
  title: Schema.String,
  body: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  state: Schema.String,
  requiresAction: Schema.Boolean,
  replySupported: Schema.Boolean,
  sourceUrl: Schema.optional(Schema.String),
  review: Schema.optional(Schema.Struct({
    taskId: Schema.String,
    boardRoot: Schema.String,
    round: Schema.NullOr(Schema.Number),
  })),
});

export const readTaskBoardHumanInboxIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TASKBOARD_HUMAN_INBOX_CHANNEL,
  payload: Schema.Void,
  result: Schema.Struct({ items: Schema.Array(itemSchema), sources: Schema.Array(sourceSchema) }),
  handler: Effect.fn("desktop.ipc.readTaskBoardHumanInbox")(function* () {
    return yield* Effect.promise(readUnifiedTaskBoardItems);
  }),
});

export async function openExactTaskBoardItem(input: { boardRoot: string; taskId: string }) {
  if (!NodePath.win32.isAbsolute(input.boardRoot) || !taskIdPattern.test(input.taskId))
    throw new Error("Invalid TaskBoard source identity");
  const items = await readUnifiedTaskBoardItems();
  const key = taskBoardSourceKey(input.boardRoot, input.taskId);
  const match = items.items.find((item) => item.sourceKey === key);
  if (!match?.boardRoot) throw new Error("TaskBoard item no longer pending; refresh the inbox");
  const exe = NodeProcess.env.T3_TASKBOARD_CLI ?? TASKBOARD_EXE;
  await NodeFS.access(exe);
  const args = ["--open-review", match.boardRoot, match.sourceId];
  // Spawn a separate native TaskBoard window, not an external browser or a
  // filesystem file: it opens the existing rich Review/Feedback queue.
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  return { launched: true as const, sourceKey: key };
}

export const openTaskBoardHumanItemIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TASKBOARD_HUMAN_OPEN_CHANNEL,
  payload: Schema.Struct({ boardRoot: Schema.String, taskId: Schema.String }),
  result: Schema.Struct({ launched: Schema.Literal(true), sourceKey: Schema.String }),
  handler: (input) => Effect.tryPromise(() => openExactTaskBoardItem(input)),
});
