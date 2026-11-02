// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Local desktop-only TaskBoard session activation.
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimers from "node:timers";
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";
import { boardRoots } from "./taskBoardHumanInboxIpc.ts";

const TASK_ID = /^[A-Z][A-Z0-9]{0,11}-\d{4,}$/u;
const CLI = "D:/SSDProjects/Tools/t3code/scripts/chatgpt-sessions.mjs";
const MAX_OUTPUT = 128 * 1024;

export interface TaskBoardSessionOpenInput {
  boardRoot: string;
  taskId: string;
  kind?: "chatgpt" | "claude" | "codex" | undefined;
  environmentId?: string | undefined;
}
export interface TaskBoardSessionOpenReceipt {
  status: string;
  kind?: string;
  sessionId?: string;
  threadId?: string;
  message?: string;
}

export async function openTaskBoardLiveSession(
  input: TaskBoardSessionOpenInput,
): Promise<TaskBoardSessionOpenReceipt> {
  if (!TASK_ID.test(input.taskId) || !NodePath.win32.isAbsolute(input.boardRoot))
    throw new Error("Live task needs a registered board and exact task ID.");
  const root = NodePath.win32.normalize(input.boardRoot).replace(/[\\/]+$/g, "").toLowerCase();
  const registered = await boardRoots();
  if (!registered.some((board) =>
    NodePath.win32.normalize(board).replace(/[\\/]+$/g, "").toLowerCase() === root))
    throw new Error("TaskBoard root is not registered; refresh the TaskBoard project catalog.");
  if (input.kind && !["chatgpt", "claude", "codex"].includes(input.kind))
    throw new Error("Unknown live-task session kind.");
  if (input.environmentId && input.environmentId.length > 128)
    throw new Error("Invalid T3 environment identity.");
  await NodeFS.access(CLI);
  // The CLI owns the per-task durable lock, spawn journal and exact-session
  // reconciliation. Do not implement separate retry or creation here.
  const payload = JSON.stringify({
    action: "open-task",
    taskRef: { board: input.boardRoot, id: input.taskId },
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
  });
  return await new Promise<TaskBoardSessionOpenReceipt>((resolve, reject) => {
    const child = spawn("node.exe", [CLI], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, receipt?: TaskBoardSessionOpenReceipt) => {
      if (settled) return;
      settled = true;
      NodeTimers.clearTimeout(timer);
      if (error) reject(error);
      else resolve(receipt ?? { status: "unknown", message: "No receipt; inspect TaskBoard before retrying." });
    };
    const timer = NodeTimers.setTimeout(() => {
      child.kill();
      finish(undefined, {
        status: "unknown",
        message: "Open-task outcome unknown. Check the original task and T3 registry before trying again.",
      });
    }, 130_000);
    child.once("error", (error) => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_OUTPUT) {
        child.kill();
        finish(new Error("Oversized TaskBoard open-session receipt."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(stderr.trim() || "Open-task failed. Its outcome may be unknown; never spawn a duplicate."));
        return;
      }
      try {
        const value: unknown = JSON.parse(output);
        if (!value || typeof value !== "object" || !("taskRef" in value) ||
          !value.taskRef || typeof value.taskRef !== "object" ||
          !("board" in value.taskRef) || !("id" in value.taskRef) ||
          NodePath.win32.normalize(String(value.taskRef.board)).toLowerCase() !==
            NodePath.win32.normalize(input.boardRoot).toLowerCase() ||
          value.taskRef.id !== input.taskId || !("status" in value) ||
          typeof value.status !== "string") {
          throw new Error("T3 returned a mismatched task/session receipt.");
        }
        const receipt = value as TaskBoardSessionOpenReceipt;
        finish(undefined, {
          status: receipt.status,
          ...(typeof receipt.kind === "string" ? { kind: receipt.kind } : {}),
          ...(typeof receipt.sessionId === "string" ? { sessionId: receipt.sessionId } : {}),
          ...(typeof receipt.threadId === "string" ? { threadId: receipt.threadId } : {}),
          ...(typeof receipt.message === "string" ? { message: receipt.message } : {}),
        });
      } catch (error) {
        finish(new Error("Could not verify the open-task receipt: " + String(error)));
      }
    });
    child.stdin.end(payload + "\n");
  });
}

export const openTaskBoardLiveSessionIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TASKBOARD_LIVE_SESSION_OPEN_CHANNEL,
  payload: Schema.Struct({
    boardRoot: Schema.String,
    taskId: Schema.String,
    kind: Schema.optional(Schema.Literals(["chatgpt", "claude", "codex"])),
    environmentId: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({
    status: Schema.String,
    kind: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    threadId: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
  handler: (input) => Effect.tryPromise(() => openTaskBoardLiveSession(input)),
});

/** Only a user click can postpone/dismiss a live task. No auto-action on snapshots. */
export async function controlTaskBoardLiveSession(input: {
  boardRoot: string;
  taskId: string;
  action: "later" | "clear";
  until?: string | undefined;
}): Promise<{ applied: true }> {
  if (!TASK_ID.test(input.taskId) || !NodePath.win32.isAbsolute(input.boardRoot))
    throw new Error("Invalid live TaskBoard identity.");
  const root = NodePath.win32.normalize(input.boardRoot).replace(/[\\/]+$/g, "").toLowerCase();
  const registered = await boardRoots();
  if (!registered.some((board) =>
    NodePath.win32.normalize(board).replace(/[\\/]+$/g, "").toLowerCase() === root))
    throw new Error("TaskBoard root is not registered.");
  if (!["later", "clear"].includes(input.action)) throw new Error("Unknown live-task action.");
  if (input.action === "later" &&
      (!input.until || !Number.isFinite(Date.parse(input.until)) || Date.parse(input.until) <= Date.now()))
    throw new Error("Later requires a future ISO timestamp.");
  const cli = NodeProcess.env.T3_TASKBOARD_CLI ??
    "D:/SSDProjects/Tools/TaskBoard/packages/task-cli/target/release/taskboard.exe";
  await NodeFS.access(cli);
  const args = ["--json", "--root", input.boardRoot, "task", "live", input.action, input.taskId,
    ...(input.action === "later" ? ["--until", input.until!] : [])];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      NodeTimers.clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = NodeTimers.setTimeout(() => {
      child.kill();
      finish(new Error("TaskBoard action outcome unknown; refresh the task before repeating."));
    }, 30_000);
    child.once("error", finish);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || "TaskBoard action failed."));
    });
  });
  return { applied: true };
}
export const controlTaskBoardLiveSessionIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TASKBOARD_LIVE_SESSION_CONTROL_CHANNEL,
  payload: Schema.Struct({
    boardRoot: Schema.String,
    taskId: Schema.String,
    action: Schema.Literals(["later", "clear"]),
    until: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({ applied: Schema.Literal(true) }),
  handler: (input) => Effect.tryPromise(() => controlTaskBoardLiveSession(input)),
});
