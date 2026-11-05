// @effect-diagnostics nodeBuiltinImport:off -- T3 starts the native TaskBoard desktop app on Windows.
import * as NodeCP from "node:child_process";
import * as NodeFS from "node:fs/promises";

const TASKBOARD_APP = process.env.T3_TASKBOARD_GUI_EXE ??
  "D:/SSDProjects/Tools/TaskBoard/src-tauri/target/release/taskboard.exe";

let pending: Promise<void> | null = null;

/** Launch TaskBoard when Keep T3 Busy is enabled, without refocusing an existing window. */
export function ensureTaskBoardAppRunning(): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  if (pending) return pending;
  pending = (async () => {
    const running = await new Promise<boolean>((resolve) => {
      NodeCP.execFile("tasklist.exe", ["/FI", "IMAGENAME eq taskboard.exe", "/FO", "CSV", "/NH"],
        { windowsHide: true, timeout: 3_000 }, (error, stdout) => {
          resolve(!error && /^\s*"taskboard\.exe"\s*,/im.test(stdout));
        });
    });
    if (running) return;
    await NodeFS.access(TASKBOARD_APP);
    await new Promise<void>((resolve, reject) => {
      const child = NodeCP.spawn(TASKBOARD_APP, [], {
        detached: true, stdio: "ignore", windowsHide: false,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  })().finally(() => { pending = null; });
  return pending;
}
