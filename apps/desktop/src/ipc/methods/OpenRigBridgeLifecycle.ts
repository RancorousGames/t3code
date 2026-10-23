// @effect-diagnostics nodeBuiltinImport:off -- narrow opt-in Windows service adapter.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const HEALTH_URL = "http://127.0.0.1:7433/healthz";
// The default is the operator's Windows checkout; on other machines a
// nonexisting checkout fails closed rather than starting a generic daemon.
const ROOT = process.env.OPENRIG_T3_BRIDGE_ROOT ?? String.raw`D:\SSDProjects\Tools\OpenRig`;
// Select this mode explicitly in the desktop launch environment BEFORE startup.
// Unset OPENRIG_T3_BRIDGE_MODE (or set 'auto') and restart T3 to restore fallback.
export function bridgeStartupMode(value: string | undefined): "auto" | "maintenance-no-phase1-autostart" {
  if (value === undefined || value === "" || value === "auto") return "auto";
  if (value === "maintenance-no-phase1-autostart") return value;
  throw new Error("Invalid OPENRIG_T3_BRIDGE_MODE; use 'auto' or 'maintenance-no-phase1-autostart'.");
}

let ownedChild: NodeChildProcess.ChildProcess | null = null;
let starting: Promise<void> | null = null;
let shutdownRegistered = false;

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

/**
 * Never infer that an unresponsive occupied port is free. Only an explicit
 * TCP connection refusal permits a launch. A responding OpenRig daemon is
 * adopted without creating another process.
 */
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

/** Retain the existing default health contract for normal T3 startup. */
export async function bridgeHealth(fetchImpl: typeof fetch = fetch): Promise<"online" | "absent"> {
  return (await bridgeIdentity(fetchImpl)) === "absent" ? "absent" : "online";
}

async function launchLocalBridge(): Promise<void> {
  const mode = bridgeStartupMode(process.env.OPENRIG_T3_BRIDGE_MODE);
  const health = await bridgeIdentity();
  if (mode === "maintenance-no-phase1-autostart") {
    // A stale Phase-1 child must not masquerade as the canonical full daemon.
    // Observe it, but never stop it or attempt to take its port here.
    if (health === "daemon") return;
    if (health === "phase1") {
      throw new Error("OpenRig unavailable: Phase-1 bridge still responds on port 7433; it is not the full daemon. Maintenance mode will not relaunch or terminate it.");
    }
    throw new Error("OpenRig unavailable: maintenance/no-Phase1-autostart is active; no Phase-1 bridge was launched. Set OPENRIG_T3_BRIDGE_MODE=auto (or unset it) before restarting T3 to restore fallback.");
  }
  if (health !== "absent") return;
  if (!ROOT) throw new Error("OpenRig bridge autostart is not configured on this platform.");
  const script = NodePath.join(ROOT, "scripts", "omni", "serve-t3-bridge.mts");
  const database = NodePath.join(
    process.env.OPENRIG_HOME ?? NodePath.join(NodeOS.homedir(), ".openrig"),
    "openrig.sqlite",
  );
  if (!NodeFS.existsSync(script) || !NodeFS.existsSync(database)) {
    throw new Error("Local OpenRig checkout or seeded database is unavailable.");
  }

  // One child is owned by this desktop process only. Existing listeners are
  // adopted, never killed; child exit is observed but never blindly retried.
  if (ownedChild && ownedChild.exitCode === null && !ownedChild.killed) {
    throw new Error("An OpenRig startup is still pending; refusing duplicate launch.");
  }
  const child = NodeChildProcess.spawn(
    process.env.OPENRIG_T3_NODE_EXECUTABLE || "node",
    ["--import", "tsx", script],
    {
      cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: false,
      env: { ...process.env, OPENRIG_T3_DESKTOP_PARENT_PID: String(process.pid) },
    },
  );
  ownedChild = child;
  let stderr = "";
  child.stderr?.on("data", (part: Buffer | string) => {
    stderr = (stderr + String(part)).slice(-1200);
  });
  if (!shutdownRegistered) {
    shutdownRegistered = true;
    process.once("exit", () => ownedChild?.kill());
  }
  let launchError: Error | null = null;
  child.once("error", error => {
    launchError = error;
    if (ownedChild === child) ownedChild = null;
  });
  child.once("exit", () => {
    if (ownedChild === child) ownedChild = null;
  });
  for (let attempt = 0; attempt < 36; attempt++) {
    await NodeTimersPromises.setTimeout(250);
    if (launchError) break;
    try {
      if (await bridgeHealth() === "online") return;
    } catch {
      // An indeterminate/occupied listener must not trigger another spawn.
      break;
    }
    if (child.exitCode !== null) break;
  }
  throw launchError ?? new Error(
    stderr.trim()
      ? "OpenRig startup failed: " + stderr.trim().slice(-300)
      : "OpenRig bridge did not become healthy (exit code: " + String(child.exitCode) + ").",
  );
}

export function ensureLocalOpenRigBridge(): Promise<void> {
  if (!starting) {
    starting = launchLocalBridge().finally(() => { starting = null; });
  }
  return starting;
}
