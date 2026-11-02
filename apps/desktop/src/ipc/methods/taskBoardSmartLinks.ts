// Constrained local desktop link actions. ChatGPT-rendered URLs never supply
// arbitrary executables, shell strings or filesystem destinations.
// @effect-diagnostics nodeBuiltinImport:off
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const VAULT = "B:\\GDrive\\SharedWithPhone\\Obsidian\\jjj";
const TASKBOARD_EXE = "D:\\SSDProjects\\Tools\\TaskBoard\\TaskBoard.exe";
const FIREFOX_EXE = "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
const TASK_ID = /^[A-Z][A-Z0-9]{1,12}-[0-9]{3,7}$/;
const BOARD = /^[\p{L}\p{N} _.-]{1,70}$/u;

async function launch(executable: string, args: readonly string[]) {
  await Fs.access(executable);
  await new Promise<void>((resolve, reject) => {
    const child = ChildProcess.spawn(executable, [...args], {
      cwd: Path.dirname(executable), windowsHide: true,
      detached: true, stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function openTaskBoardLink(request: {
  taskId: string; mode: "task" | "review"; board?: string | undefined;
}): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("TaskBoard desktop links require Windows.");
  if (!TASK_ID.test(request.taskId) || (request.board && !BOARD.test(request.board)))
    throw new Error("Invalid TaskBoard identifier or project.");
  const folders = await Fs.readdir(VAULT, { withFileTypes: true });
  const candidates: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory() || (request.board && folder.name.toLowerCase() !== request.board.toLowerCase()))
      continue;
    const path = Path.join(VAULT, folder.name, "Tasks");
    if (!(await Fs.stat(Path.join(path, "_board.md")).catch(() => null))?.isFile()) continue;
    const found = await Promise.all(["Active", "Archive", "Archived", ""].map((part) =>
      Fs.stat(Path.join(path, part, `${request.taskId}.md`)).then((stat) => stat.isFile()).catch(() => false)));
    if (found.some(Boolean)) candidates.push(path);
  }
  if (candidates.length !== 1) throw new Error(
    candidates.length ? "Task ID appears on several boards; specify ?board=<project>."
      : "TaskBoard task not found in registered vault folders.");
  await launch(TASKBOARD_EXE, [request.mode === "review" ? "--open-review" : "--open-task",
    candidates[0]!, request.taskId]);
  return true;
}

/** Presentations run in Firefox, never in a T3 guest or Chromium profile. */
export async function openFirefoxLink(url: string): Promise<boolean> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) ||
      !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
      parsed.port !== "3333" || !parsed.pathname.startsWith("/presentations/")) {
    throw new Error("Only OmniHub presentation URLs may launch Firefox through this action.");
  }
  await launch(FIREFOX_EXE, [url]);
  return true;
}

const WARTRIBES = "D:\\Wartribes";
const PYTHON_EXE = "C:\\Program Files\\Python313\\python.exe";
const TOUR_SCENARIO = /^[a-z][a-z0-9_]{0,70}$/;

/** A clicked tour link may launch only an installed, authored scenario.
 * The tour runner's own build/editor reservation remains authoritative. */
export async function openWartribesTour(scenario: string): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("Wartribes tours require Windows.");
  if (!TOUR_SCENARIO.test(scenario)) throw new Error("Invalid tour scenario name.");
  const manifest = Path.join(WARTRIBES, "Tools", "tours", `${scenario}.tour.json`);
  if (!(await Fs.stat(manifest).catch(() => null))?.isFile())
    throw new Error(`No authored Wartribes tour named ${scenario}.`);
  await Fs.access(PYTHON_EXE);
  await new Promise<void>((resolve, reject) => {
    const child = ChildProcess.spawn(PYTHON_EXE,
      ["-B", "Tools/run_scripted_tour.py", "--scenario", scenario, "--guided", "--leave-open"],
      { cwd: WARTRIBES, windowsHide: false, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  return true;
}

export const openWartribesTourIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_WARTRIBES_TOUR_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: (scenario) => Effect.tryPromise(() => openWartribesTour(scenario)),
});

export const openTaskBoardLinkIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_TASKBOARD_LINK_CHANNEL,
  payload: Schema.Struct({
    taskId: Schema.String,
    mode: Schema.Literals(["task", "review"]),
    board: Schema.optional(Schema.String),
  }),
  result: Schema.Boolean,
  handler: (request) => Effect.tryPromise(() => openTaskBoardLink(request)),
});

export const openFirefoxLinkIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_FIREFOX_LINK_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: (url) => Effect.tryPromise(() => openFirefoxLink(url)),
});
