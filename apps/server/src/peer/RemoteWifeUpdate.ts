// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- detached Windows updater and durable deployment status use native process/filesystem APIs.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type UpdateState = "queued" | "running" | "succeeded" | "failed";
interface UpdateStatus {
  readonly state: UpdateState;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly message: string;
  readonly logPath: string;
}

const statusDirectory = () => join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "T3MoriDeployment");
const statusFile = () => join(statusDirectory(), "remote-update.json");
const updateLog = () => join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "T3MonkuInstaller", "launcher.log");

const readStatus = (): UpdateStatus | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(statusFile(), "utf8").replace(/^\uFEFF/, ""));
    if (typeof value !== "object" || value === null || !("state" in value) ||
        !["queued", "running", "succeeded", "failed"].includes(String(value.state))) return null;
    return value as UpdateStatus;
  } catch {
    return null;
  }
};

const findCheckout = (): string | undefined => {
  const fromModule = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.cwd(),
    join(homedir(), "t3code"),
    ...Array.from({ length: 9 }, (_, index) => resolve(fromModule, ...Array(index + 1).fill(".."))),
  ];
  return candidates.find((directory) => existsSync(join(directory, "deploy", "wife", "Update-Wife.ps1")) &&
    existsSync(join(directory, "deploy", "remote", "Run-WifeUpdate.ps1")));
};

/** A detached child survives T3's own graceful restart; state is read again after reconnecting. */
export const startRemoteWifeUpdate = () => {
  const current = readStatus();
  if (current && (current.state === "queued" || current.state === "running") &&
    Date.now() - Date.parse(current.startedAt) < 2 * 60 * 60 * 1000) {
    return { ...current, message: "An update is already in progress. Check status instead." };
  }
  const checkout = findCheckout();
  if (!checkout) throw new Error("Updater not installed on this machine. Install the in-repo deploy/wife updater first.");
  mkdirSync(statusDirectory(), { recursive: true });
  const status: UpdateStatus = {
    state: "queued",
    startedAt: new Date().toISOString(),
    message: "Update queued. T3 may disconnect briefly during its restart.",
    logPath: updateLog(),
  };
  writeFileSync(statusFile(), JSON.stringify(status), "utf8");
  try {
    const worker = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(checkout, "deploy", "remote", "Run-WifeUpdate.ps1"), "-Checkout", checkout,
      "-StartedAt", status.startedAt,
    ], { detached: true, windowsHide: true, stdio: "ignore", cwd: checkout });
    worker.on("error", (error) => {
      const failed: UpdateStatus = {
        ...status, state: "failed", finishedAt: new Date().toISOString(),
        message: `Could not launch updater: ${String(error)}`,
      };
      writeFileSync(statusFile(), JSON.stringify(failed), "utf8");
    });
    worker.unref();
    return status;
  } catch (error) {
    const failed: UpdateStatus = { ...status, state: "failed", finishedAt: new Date().toISOString(), message: String(error) };
    writeFileSync(statusFile(), JSON.stringify(failed), "utf8");
    return failed;
  }
};

export const remoteWifeUpdateStatus = () => readStatus() ?? ({
  state: "failed" as const,
  startedAt: "",
  message: "No remote update has been requested on this machine.",
  logPath: updateLog(),
});
