/** Explicit opt-in real Windows/OpenRig integration acceptance.
 * Testbed redirects ONLY the healthz TCP destination to an isolated port
 * and substitutes an isolated, guarded startup script; it does not mock
 * fetch refusal, child_process.spawn, or the installed rig CLI.
 * Run with T3_OPENRIG_LIVE_ACCEPTANCE=1 and T3_OPENRIG_ACCEPTANCE_ROOT
 * pointing to a disposable testbed script on a Windows host. */
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";

const lab = process.env.T3_OPENRIG_ACCEPTANCE_ROOT ?? "";
const isolatedPort = 17455;
const healthz = `http://127.0.0.1:${isolatedPort}/healthz`;
const canonicalHealthz = "http://127.0.0.1:7433/healthz";
const installedScript = path.join(lab, "manage-openrig-daemon.ps1");
const isolatedHome = path.join(lab, "profile");
const enabled =
  process.env.T3_OPENRIG_LIVE_ACCEPTANCE === "1" && Boolean(lab) && process.platform === "win32";
const fetchNative = globalThis.fetch.bind(globalThis);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.skipIf(!enabled)(
  "actual T3 auto-start recovers a genuine ECONNREFUSED via installed CLI and cleanly drains",
  async () => {
    expect(existsSync(installedScript)).toBe(true);
    const prodBefore = (await (await fetchNative(canonicalHealthz)).json()) as {
      pid: number;
      status: string;
    };
    expect(prodBefore.status).toBe("ok");

    // A real Windows TCP refusal is required, not a simulated rejected Promise.
    await expect(fetchNative(healthz)).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "ECONNREFUSED" }),
    });

    vi.stubEnv("OPENRIG_T3_BRIDGE_MODE", "auto");
    vi.stubEnv("OPENRIG_T3_BRIDGE_ROOT", lab);
    vi.stubGlobal("fetch", ((resource: string | URL | Request, init?: RequestInit) => {
      const requested = String(resource);
      return fetchNative(requested === canonicalHealthz ? healthz : resource, init);
    }) as typeof fetch);
    vi.resetModules();
    const { ensureLocalOpenRigBridge } = await import("./OpenRigBridgeLifecycle.ts");
    let startedPid: number | undefined;
    try {
      const first = ensureLocalOpenRigBridge();
      const second = ensureLocalOpenRigBridge();
      expect(second).toBe(first);
      await Promise.all([first, second]);
      // TCP health may bind milliseconds before the detached CLI publishes daemon.json.
      await vi.waitFor(
        () => expect(existsSync(path.join(isolatedHome, "daemon.json"))).toBe(true),
        {
          timeout: 20_000,
          interval: 100,
        },
      );
      const state = JSON.parse(readFileSync(path.join(isolatedHome, "daemon.json"), "utf8")) as {
        pid: number;
        port: number;
        db: string;
      };
      const health = (await (await fetchNative(healthz)).json()) as { pid: number; status: string };
      expect(state.port).toBe(isolatedPort);
      expect(state.pid).toBe(health.pid);
      expect(health.status).toBe("ok");
      startedPid = state.pid;
      await ensureLocalOpenRigBridge(); // healthy adoption, no duplicate
      const stateAfter = JSON.parse(
        readFileSync(path.join(isolatedHome, "daemon.json"), "utf8"),
      ) as { pid: number };
      expect(stateAfter.pid).toBe(startedPid);
    } finally {
      if (existsSync(path.join(isolatedHome, "daemon.json"))) {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            installedScript,
            "-Action",
            "stop",
          ],
          { cwd: lab, timeout: 90000, windowsHide: true, stdio: "pipe" },
        );
      }
    }
    expect(startedPid).toBeTypeOf("number");
    const receipt = JSON.parse(
      readFileSync(path.join(isolatedHome, "daemon-shutdown.json"), "utf8"),
    ) as {
      pid: number;
      outcome: string;
      phase: string;
    };
    expect(receipt.pid).toBe(startedPid);
    expect(receipt.outcome).toBe("clean");
    expect(receipt.phase).toBe("complete");
    expect(existsSync(path.join(isolatedHome, "daemon.json"))).toBe(false);
    // A fresh socket must refuse after draining. Node fetch can reuse a keep-alive
    // connection and transiently return ECONNRESET instead, which is not listener proof.
    const refusalCode = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: isolatedPort });
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("Isolated listener unexpectedly remained bound"));
      });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "unknown"));
    });
    expect(refusalCode).toBe("ECONNREFUSED");
    const prodAfter = (await (await fetchNative(canonicalHealthz)).json()) as {
      pid: number;
      status: string;
    };
    expect(prodAfter.status).toBe("ok");
    expect(prodAfter.pid).toBe(prodBefore.pid);
  },
  125_000,
);
