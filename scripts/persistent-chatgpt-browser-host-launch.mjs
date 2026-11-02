// Launch/reconnect to the browser host without joining its lifetime to T3.
// This is opt-in until the desktop ChatGPT view is migrated off <webview>.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  defaultDataDirectory,
  requestBrowserHost,
  socketFor,
} from "./persistent-chatgpt-browser-host.mjs";

const moduleDir = Path.dirname(fileURLToPath(import.meta.url));
const hostScript = Path.join(moduleDir, "persistent-chatgpt-offscreen-host.cjs");
const electronBinary = Path.join(moduleDir, "..", "apps", "desktop", "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const tokenFor = (directory) => {
  Fs.mkdirSync(directory, { recursive: true });
  const file = Path.join(directory, "owner-token");
  try {
    Fs.writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const token = Fs.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid persistent browser host owner token");
  return token;
};

/**
 * If the live owner is already running, return it without touching its pages.
 * Otherwise detach a new process and wait only for its control pipe. Its
 * Chromium context starts lazily when a session is explicitly attached.
 */
export async function ensureBrowserHost({
  dataDirectory = defaultDataDirectory(),
  executable = electronBinary,
  script = hostScript,
  timeoutMs = 5000,
} = {}) {
  const socketPath = socketFor(dataDirectory);
  const token = tokenFor(dataDirectory);
  try {
    const existing = await requestBrowserHost(socketPath, "GET", "/health", undefined, token);
    return { ...existing, socketPath, reused: true };
  } catch (error) {
    // Only a missing endpoint permits starting a new owner. If an existing
    // broker replies with an error, don't replace it or steal its profile.
    if (!["ENOENT", "ECONNREFUSED"].includes(error?.code)) throw error;
  }

  if (!Fs.existsSync(executable)) throw new Error("Dedicated Chromium Electron runtime is missing");
  Fs.mkdirSync(dataDirectory, { recursive: true });
  const logFd = Fs.openSync(Path.join(dataDirectory, "browser-host.log"), "a");
  let child;
  try {
    child = spawn(executable, [script, dataDirectory], {
      cwd: moduleDir,
      detached: true,
      windowsHide: true,
      // The separate Electron executable owns invisible offscreen BrowserWindows.
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE")),
        T3_BROWSER_HOST_TOKEN: token },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    Fs.closeSync(logFd);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(80);
    try {
      const status = await requestBrowserHost(socketPath, "GET", "/health", undefined, token);
      return { ...status, socketPath, reused: false };
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error?.code)) throw error;
    }
  }
  throw new Error("Persistent browser host did not start; see " + Path.join(dataDirectory, "browser-host.log"));
}

if (process.argv[1] && Path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "status";
  const directory = process.argv[3] ?? defaultDataDirectory();
  const pipe = socketFor(directory);
  const token = tokenFor(directory);
  try {
    const result = command === "start"
      ? await ensureBrowserHost({ dataDirectory: directory })
      : command === "status"
        ? await requestBrowserHost(pipe, "GET", "/health", undefined, token)
        : command === "memory"
        ? await requestBrowserHost(pipe, "GET", "/sessions/memory", undefined, token)
      : command === "list"
          ? await requestBrowserHost(pipe, "GET", "/sessions", undefined, token)
          : command === "stop"
            ? await requestBrowserHost(pipe, "POST", "/shutdown", undefined, token)
            : command === "attach-chatgpt" && process.argv[4]
              ? await requestBrowserHost(pipe, "POST", "/sessions/attach",
                { sessionId: process.argv[4], initialUrl: "https://chatgpt.com/" }, token)
              : (() => { throw new Error("Usage: start|status|list|memory|stop|attach-chatgpt SESSION_ID [data-dir]"); })();
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  }
}
