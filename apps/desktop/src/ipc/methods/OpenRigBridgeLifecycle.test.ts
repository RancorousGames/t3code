import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { bridgeHealth, bridgeStartupMode, canonicalDaemonStartScript, ensureLocalOpenRigBridge } from "./OpenRigBridgeLifecycle.ts";

describe("OpenRig canonical daemon startup gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("validates normal and legacy maintenance modes without permitting Phase-1 fallback", () => {
    expect(bridgeStartupMode(undefined)).toBe("auto");
    expect(bridgeStartupMode("")).toBe("auto");
    expect(bridgeStartupMode("auto")).toBe("auto");
    expect(bridgeStartupMode("maintenance-no-phase1-autostart")).toBe("maintenance-no-phase1-autostart");
    expect(() => bridgeStartupMode("maintenance")).toThrow("Invalid OPENRIG_T3_BRIDGE_MODE");
  });

  it("never selects a source/tsx or Phase-1 fallback when canonical installation is missing", () => {
    expect(() => canonicalDaemonStartScript("Z:/missing/OpenRig")).toThrow("Canonical OpenRig daemon start script is unavailable");
  });

  it("adopts a responding full daemon without creating Phase-1 in maintenance mode", async () => {
    vi.stubEnv("OPENRIG_T3_BRIDGE_MODE", "maintenance-no-phase1-autostart");
    const responding = vi.fn(async () => Response.json({ status: "ok", fullRigDaemon: true })) as typeof fetch;
    vi.stubGlobal("fetch", responding);

    await expect(ensureLocalOpenRigBridge()).resolves.toBeUndefined();
    expect(responding).toHaveBeenCalledTimes(1);
  });

  it("does not accept an existing Phase-1 child as the canonical daemon", async () => {
    vi.stubEnv("OPENRIG_T3_BRIDGE_MODE", "maintenance-no-phase1-autostart");
    const phase1 = vi.fn(async () => Response.json({
      ok: true, service: "openrig-t3-phase1-bridge", fullRigDaemon: false,
    })) as typeof fetch;
    vi.stubGlobal("fetch", phase1);

    await expect(ensureLocalOpenRigBridge()).rejects.toThrow("occupied by legacy OpenRig Phase-1");
    expect(phase1).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown operator mode before any probe or launch", async () => {
    vi.stubEnv("OPENRIG_T3_BRIDGE_MODE", "maintenance");
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchSpy);

    await expect(ensureLocalOpenRigBridge()).rejects.toThrow("Invalid OPENRIG_T3_BRIDGE_MODE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("adopts an existing OpenRig Phase-1 bridge or full daemon", async () => {
    for (const payload of [
      { ok: true, service: "openrig-t3-phase1-bridge", fullRigDaemon: false },
      { status: "ok", pid: 123 },
    ]) {
      const request = vi.fn(async () => Response.json(payload)) as typeof fetch;
      await expect(bridgeHealth(request)).resolves.toBe("online");
      expect(request).toHaveBeenCalledWith("http://127.0.0.1:7433/healthz",
        expect.objectContaining({ cache: "no-store", redirect: "error" }));
    }
  });

  it("only permits auto-start after explicit connection refusal", async () => {
    const refused = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    }) as typeof fetch;
    await expect(bridgeHealth(refused)).resolves.toBe("absent");
    const unknown = vi.fn(async () => { throw new Error("timed out"); }) as typeof fetch;
    await expect(bridgeHealth(unknown)).rejects.toThrow("indeterminate");
    const occupied = vi.fn(async () => Response.json({ ok: true, service: "unrelated-service" })) as typeof fetch;
    await expect(bridgeHealth(occupied)).rejects.toThrow("Unexpected service");
    const errors = vi.fn(async () => Response.json({}, { status: 404 })) as typeof fetch;
    await expect(bridgeHealth(errors)).rejects.toThrow("occupies");
  });
});
