import { describe, expect, it, vi } from "vite-plus/test";
import { requestCanonicalSeatReboot } from "./OpenRigSeatReboot.js";

const seatId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const opts = { bearer: "fake-local-bearer", operatorToken: "fake-local-operator-token-for-test" };
const input = { seatId, sessionId, requestId, phase: "begin" as const };
const receipt = { version: 1, operation: "reboot_agent", seatId, sessionId, requestId,
  managedSessionId: "44444444-4444-4444-8444-444444444444", rebootGeneration: null,
  status: "submitted", reason: null, retrySafe: false };

describe("canonical OpenRig same-seat reboot MAIN transport", () => {
  it("requires stable exact IDs and MAIN-only operator authority before sending", async () => {
    const send = vi.fn();
    await expect(requestCanonicalSeatReboot({ ...input, requestId: "not-a-uuid" },
      { ...opts, fetchImpl: send })).rejects.toThrow("UUID");
    await expect(requestCanonicalSeatReboot(input,
      { ...opts, operatorToken: null, fetchImpl: send })).rejects.toThrow("operator authority");
    expect(send).not.toHaveBeenCalled();
  });
  it("posts only one begin and accepts the matching canonical receipt", async () => {
    const send = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 200 }));
    expect(await requestCanonicalSeatReboot(input, { ...opts, fetchImpl: send })).toEqual(receipt);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, request] = send.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain(`/agents/${seatId}/reboots`);
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toEqual({ requestId, sessionId });
    expect((request.headers as Record<string, string>)["x-openrig-rollover-operator-token"])
      .toBe(opts.operatorToken);
  });
  it("never retries a timed-out begin; supports read-only exact status", async () => {
    const failed = vi.fn(async () => { throw new Error("lost socket"); });
    await expect(requestCanonicalSeatReboot(input, { ...opts, fetchImpl: failed }))
      .rejects.toThrow(`UNKNOWN for exact request ${requestId}`);
    expect(failed).toHaveBeenCalledTimes(1);
    const read = vi.fn(async () => new Response(JSON.stringify(receipt), { status: 200 }));
    await requestCanonicalSeatReboot({ ...input, phase: "status" }, { ...opts, fetchImpl: read });
    const [url, args] = read.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/agents/${seatId}/reboots/${requestId}$`));
    expect(args.method).toBe("GET");
  });
  it("distinguishes middleware refusal from ambiguous dispatch failure", async () => {
    const unauthorized = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    await expect(requestCanonicalSeatReboot(input, { ...opts, fetchImpl: unauthorized }))
      .rejects.toThrow("pre-dispatch authorization rejected");
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });  it("rejects a receipt for a different seat or request", async () => {
    const wrong = async () => new Response(JSON.stringify({ ...receipt, sessionId: seatId }), { status: 200 });
    await expect(requestCanonicalSeatReboot(input, { ...opts, fetchImpl: wrong }))
      .rejects.toThrow("Unverified OpenRig reboot receipt");
  });
});
