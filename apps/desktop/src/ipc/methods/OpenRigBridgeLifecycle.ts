// @effect-diagnostics nodeBuiltinImport:off -- fixed local Windows daemon startup adapter.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const HEALTH_URL = "http://127.0.0.1:7433/healthz";
const ROOT = process.env.OPENRIG_T3_BRIDGE_ROOT ?? String.raw`D:\SSDProjects\Tools\OpenRig`;

// The historical maintenance flag forbids a reduced Phase-1 server. Both modes
// now start ONLY the installed canonical daemon, never a source/tsx fallback.
export function bridgeStartupMode(value: string | undefined): "auto" | "maintenance-no-phase1-autostart" {
  if (value === undefined || value === "" || value === "auto") return "auto";
  if (value === "maintenance-no-phase1-autostart") return value;
  throw new Error("Invalid OPENRIG_T3_BRIDGE_MODE; use 'auto' or 'maintenance-no-phase1-autostart'.");
}

let starting: Promise<void> | null = null;
let launcher: NodeChildProcess.ChildProcess | null = null;

function refused(error: unknown): boolean {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null;
  const code = cause && typeof cause === "object" && "code" in cause
    ? (cause as { code?: unknown }).code : null;
  if (code === "ECONNREFUSED") return true;
  return cause instanceof AggregateError && cause.errors.length > 0 &&
    cause.errors.every((entry: unknown) =>
      entry && typeof entry === "object" && "code" in entry &&
      (entry as { code?: unknown }).code === "ECONNREFUSED");
}

/** Only a definitive connection refusal authorizes startup; an occupied,
 * unresponsive or unexpected listener must never be replaced or killed. */
async function bridgeIdentity(fetchImpl: typeof fetch = fetch): Promise<"daemon" | "phase1" | "absent"> {
  let response: Response;
  try {
    response = await fetchImpl(HEALTH_URL, {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(1800),
    });
  } catch (error) {
    if (refused(error)) return "absent";
    throw new Error("OpenRig health probe is indeterminate; refusing a second listener.", { cause: error });
  }
  if (!response.ok) throw new Error("Another service occupies OpenRig port 7433.");
  const health = await response.json().catch(() => null) as unknown;
  const identity = health && typeof health === "object"
    ? health as { ok?: unknown; status?: unknown; service?: unknown } : null;
  if (!(identity?.ok === true && identity.service === "openrig-t3-phase1-bridge") &&
      identity?.status !== "ok") {
    throw new Error("Unexpected service on OpenRig port 7433.");
  }
  return identity?.service === "openrig-t3-phase1-bridge" ? "phase1" : "daemon";
}

export async function bridgeHealth(fetchImpl: typeof fetch = fetch): Promise<"online" | "absent"> {
  return (await bridgeIdentity(fetchImpl)) === "absent" ? "absent" : "online";
}

/** Resolve only the supported installed canonical startup script, never the
 * old Phase-1 checkout bridge or a second independently configured database. */
export function canonicalDaemonStartScript(root: string = ROOT): string {
  const script = NodePath.join(root, "manage-openrig-daemon.ps1");
  if (process.platform !== "win32" || !NodeFS.existsSync(script)) {
    throw new Error("Canonical OpenRig daemon start script is unavailable on this host.");
  }
  const cli = NodePath.join(process.env.LOCALAPPDATA ?? "", "OpenRig", "installed", "rig", "bin", "rig.cmd");
  if (!process.env.LOCALAPPDATA || !NodeFS.existsSync(cli)) {
    throw new Error("Installed canonical OpenRig CLI is unavailable; Phase-1 fallback disabled.");
  }
  return script;
}

async function launchCanonicalDaemon(): Promise<void> {
  bridgeStartupMode(process.env.OPENRIG_T3_BRIDGE_MODE);
  const health = await bridgeIdentity();
  if (health === "daemon") return;
  if (health === "phase1") {
    throw new Error("Port 7433 is occupied by legacy OpenRig Phase-1; canonical daemon cannot replace it automatically.");
  }
  if (launcher && launcher.exitCode === null && !launcher.killed) {
    throw new Error("Canonical OpenRig startup still pending; refusing duplicate launch.");
  }
  const script = canonicalDaemonStartScript();
  // The fixed operator script selects the installed CLI, canonical ~/.openrig
  // database and required process-private tokens. It starts a detached daemon;
  // this desktop process owns only the short-lived PowerShell launcher.
  const child = NodeChildProcess.spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script, "-Action", "start",
  ], { cwd: ROOT, windowsHide: true, stdio: "ignore" });
  launcher = child;
  let launchError: Error | null = null;
  child.once("error", (error) => { launchError = error; if (launcher === child) launcher = null; });
  child.once("exit", (code) => {
    if (code !== 0) launchError = new Error("Canonical OpenRig launcher exited with code " + String(code));
    if (launcher === child) launcher = null;
  });
  // The CLI can return before its daemon is accepting requests. Also handle
  // a concurrent external start: success is the canonical listener itself.
  for (let attempt = 0; attempt < 40; attempt++) {
    await NodeTimersPromises.setTimeout(250);
    try {
      const state = await bridgeIdentity();
      if (state === "daemon") return;
      if (state === "phase1") throw new Error("Legacy Phase-1 service occupied port 7433 during startup.");
    } catch (error) {
      // Non-refused failures do not license launching another daemon.
      if (attempt > 7) throw error;
    }
    if (launchError) break;
  }
  throw launchError ?? new Error("Canonical OpenRig daemon did not become healthy after startup.");
}

export function ensureLocalOpenRigBridge(): Promise<void> {
  if (!starting) starting = launchCanonicalDaemon().finally(() => { starting = null; });
  return starting;
}
