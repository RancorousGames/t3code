import { describe, expect, it, vi } from "vite-plus/test";
import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.js";
import type { DesktopAppActivationRequest } from "@t3tools/contracts";

const request: DesktopAppActivationRequest = {
  version: 1,
  type: "chatgpt.reboot",
  phase: "begin",
  requestId: "894f98c4-3c2a-4b2a-bafe-1d3034381111",
  sessionId: "594f98c4-3c2a-4b2a-bafe-1d3034381111",
  priorConversationId: "694f98c4-3c2a-4b2a-bafe-1d3034381111",
  prompt: "Continue",
};
describe("reboot broker no-replay boundary", () => {
  it("preserves selection and never replays on renderer replacement", async () => {
    const activate = vi.fn(),
      send = vi.fn(),
      replacement = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1000, activate });
    broker.registerRenderer(send);
    const reply = broker.request(request);
    broker.clearRenderer();
    broker.registerRenderer(replacement);
    expect(activate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      data: { status: "submitted" },
    });
    expect(await reply).toMatchObject({ ok: true });
    broker.close();
  });
  it("reports UNKNOWN after a possibly dispatched reboot instead of replaying", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1000, activate: vi.fn() });
    broker.registerRenderer(() => {
      throw new Error("lost transport");
    });
    const reply = broker.request(request);
    const replacement = vi.fn();
    broker.registerRenderer(replacement);
    broker.cancel(request.requestId);
    expect(await reply).toMatchObject({ ok: false, message: expect.stringContaining("UNKNOWN") });
    expect(replacement).not.toHaveBeenCalled();
    broker.close();
  });
});
