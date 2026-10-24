import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), existsSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));

// Exercise the real recovery entry point without starting or stopping a daemon.
// Yielding the startup delay is deterministic; readiness comes from health replies.
describe("canonical OpenRig recovery after a desktop connection loss", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.spawn.mockReset();
    mocks.existsSync.mockReturnValue(true);
    vi.stubEnv("LOCALAPPDATA", "C:/fake-local-app-data");
    vi.stubEnv("OPENRIG_T3_BRIDGE_MODE", "auto");
    vi.stubEnv("OPENRIG_T3_BRIDGE_ROOT", "D:/fake-openrig");
    mocks.spawn.mockImplementation(() =>
      Object.assign(new NodeEvents.EventEmitter(), {
        exitCode: null,
        killed: false,
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const absent = () =>
    Promise.reject(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      }),
    );

  it("recovers a previously healthy daemon and coalesces concurrent IPC probes into one canonical launch", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: "ok" }))
      .mockImplementationOnce(absent)
      .mockImplementation(async () => Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", probe);
    const { ensureLocalOpenRigBridge } = await import("./OpenRigBridgeLifecycle.ts");
    await ensureLocalOpenRigBridge();
    expect(mocks.spawn).not.toHaveBeenCalled();

    const first = ensureLocalOpenRigBridge();
    const second = ensureLocalOpenRigBridge();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining([
        "-File",
        expect.stringContaining("manage-openrig-daemon.ps1"),
        "-Action",
        "start",
      ]),
      expect.objectContaining({ windowsHide: true, stdio: "ignore" }),
    );
    await ensureLocalOpenRigBridge();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("waits for canonical readiness after launch instead of returning an unreachable snapshot", async () => {
    const probe = vi
      .fn()
      .mockImplementationOnce(absent)
      .mockImplementationOnce(absent)
      .mockImplementationOnce(absent)
      .mockImplementation(async () => Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", probe);
    const { ensureLocalOpenRigBridge } = await import("./OpenRigBridgeLifecycle.ts");
    await expect(ensureLocalOpenRigBridge()).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(4);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not launch on a transient timeout and adopts the same daemon when it responds again", async () => {
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockImplementation(async () => Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", probe);
    const { ensureLocalOpenRigBridge } = await import("./OpenRigBridgeLifecycle.ts");
    await expect(ensureLocalOpenRigBridge()).rejects.toThrow("indeterminate");
    await expect(ensureLocalOpenRigBridge()).resolves.toBeUndefined();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
