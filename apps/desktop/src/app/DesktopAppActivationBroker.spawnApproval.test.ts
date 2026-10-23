import { ProviderInstanceId, type DesktopAppActivationRequest } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";

describe("desktop native create approval boundary", () => {
  it.each(["gpt-6-astra", "gpt-5.6-luna", "gpt-6-luna", "unknown"])(
    "holds %s before focus or renderer/project side effects",
    async (model) => {
      const activate = vi.fn();
      const render = vi.fn();
      const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1000, activate });
      broker.registerRenderer(render);
      const request = {
        version: 1,
        requestId: "request-native-hold",
        type: "t3.threads",
        action: "create",
        clientRequestId: "22222222-2222-4222-8222-222222222222",
        environmentId: "local",
        workspaceRoot: "D:\\test-workspace",
        runtime: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
        runtimeMode: "approval-required",
        title: "Unapproved native session",
        approved: true,
        isHuman: true,
      } as const satisfies DesktopAppActivationRequest & { approved: boolean; isHuman: boolean };
      const responses = await Promise.all([broker.request(request), broker.request(request)]);
      expect(responses).toEqual([
        expect.objectContaining({ ok: false, code: "invalid-request" }),
        expect.objectContaining({ ok: false, code: "invalid-request" }),
      ]);
      expect(activate).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
      broker.close();
    },
  );
});
