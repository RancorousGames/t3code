import { describe, expect, it, vi } from "vite-plus/test";
import { controlOmniHubKeepAwake, isProtectedT3KeepAwake } from "./OmniHubKeepAwakeControl.ts";

const id = "bdbfebdc-6b8b-45c8-8d64-956d5acf2d26";
const target = "75a6ef99-1f30-4ac3-afe2-4ced0ad7a849";
const requestId = "8e29b2d0-4880-4e3e-bd2c-4701237166fe";
const token = "a2246e42-d712-4c6a-8f03-790a39fba100";
const monitor = (extra: Record<string, unknown> = {}) => ({
  id, token, state: "active", mandateId: "ordinary-work", callerIdentity: "other agent",
  target: { kind: "t3/chatgpt_browser", sessionId: target }, ...extra,
});
const deps = (item: Record<string, unknown>) => ({
  readStore: async () => ({ version: 1, monitors: { [id]: item } }),
  invoke: vi.fn(async () => ({ monitorId: id, state: "cancelled", lastOutcome: "explicit_cancelled" })),
});
describe("OmniHub keep-awake owner-token controls (nonvisual)", () => {
  it("forbids manager cancellation even with confirmed target", async () => {
    const m = monitor({ mandateId: "t3-manager-continuous-worker-delegation-20261026" });
    expect(isProtectedT3KeepAwake(m)).toBe(true);
    const d = deps(m);
    const receipt = await controlOmniHubKeepAwake({ monitorId: id, action: "cancel", clientRequestId: requestId, confirmedTargetId: target }, d);
    expect(receipt.code).toBe("denied");
    expect(d.invoke).not.toHaveBeenCalled();
  });
  it("requires exact target confirmation and uses scheduler's own token rather than writing the store", async () => {
    const d = deps(monitor());
    const refused = await controlOmniHubKeepAwake({ monitorId: id, action: "cancel", clientRequestId: requestId }, d);
    expect(refused.ok).toBe(false);
    expect(d.invoke).not.toHaveBeenCalled();
    const receipt = await controlOmniHubKeepAwake({ monitorId: id, action: "cancel", clientRequestId: requestId, confirmedTargetId: target }, d);
    expect(receipt).toMatchObject({ ok: true, code: "applied", monitorId: id, clientRequestId: requestId });
    expect(d.invoke).toHaveBeenCalledWith(expect.objectContaining({ apiVersion: "1", action: "cancel", monitorId: id, controlToken: token, clientRequestId: requestId }));
    expect(JSON.stringify(receipt)).not.toContain(token);
  });
  it("wake sooner requests the supported one-minute override, never an immediate guest send", async () => {
    const d = deps(monitor());
    const receipt = await controlOmniHubKeepAwake({ monitorId: id, action: "wake_in_one_minute", clientRequestId: requestId }, d);
    expect(receipt.ok).toBe(true);
    expect(d.invoke).toHaveBeenCalledWith(expect.objectContaining({ action: "set_next", nextInMinutes: 1 }));
  });
  it("does not replay uncertain sends and cannot act on in-flight monitors", async () => {
    const d = deps(monitor({ inFlight: true }));
    const receipt = await controlOmniHubKeepAwake({ monitorId: id, action: "cancel", clientRequestId: requestId, confirmedTargetId: target }, d);
    expect(receipt.code).toBe("conflict");
    expect(d.invoke).not.toHaveBeenCalled();
    const unknown = deps(monitor());
    unknown.invoke.mockRejectedValueOnce(new Error("timed out"));
    const result = await controlOmniHubKeepAwake({ monitorId: id, action: "wake_in_one_minute", clientRequestId: requestId }, unknown);
    expect(result.code).toBe("unknown");
    expect(unknown.invoke).toHaveBeenCalledTimes(1);
  });
});
