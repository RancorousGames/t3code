import { describe, expect, it } from "vite-plus/test";
import type { AgentProviderV1Session } from "@t3tools/contracts";
import {
  disconnectDesktopCatalog,
  dispatchBrowserWork,
  finishDesktopWork,
  publishDesktopCatalog,
  takeDesktopWork,
} from "./agentProviderBridge.ts";

describe("explicit phone browser load", () => {
  it("wakes the exact unloaded session without requiring ReadHistory or submitting text", async () => {
    const environmentId = "test-phone-wake";
    const owner = "test-desktop-publisher";
    const browserId = "e8400f6c-e273-425f-b50b-164b8ef3ab32";
    const session: AgentProviderV1Session = {
      ref: { provider: "t3", id: browserId },
      kind: "t3/chatgpt",
      source: { environmentId, browserSessionId: browserId, conversationId: null },
      title: "Cold browser",
      state: {
        reachability: "Unknown", activity: "Unknown", confidence: "Unknown",
        elsewhere: null, observedAt: new Date().toISOString(),
      },
      capabilities: ["Submit"],
      deliveryModes: ["WhenIdle", "WaitForSlot"],
    };
    publishDesktopCatalog(owner, environmentId, [session]);
    try {
      const loading = dispatchBrowserWork(environmentId, browserId, null, "load");
      const work = await takeDesktopWork(owner, environmentId);
      expect(work).toMatchObject({
        action: "load", browserSessionId: browserId, environmentId,
      });
      expect(work).not.toHaveProperty("text");
      expect(finishDesktopWork(owner, environmentId, work!.jobId, {
        ok: true, data: { state: "Loading" },
      })).toBe(true);
      expect(await loading).toEqual({ ok: true, data: { state: "Loading" } });
      const wrongId = await dispatchBrowserWork(
        environmentId, "2cd492ec-8b9b-4a02-a059-511247c60ff7", null, "load",
      );
      expect(wrongId).toMatchObject({ ok: false, code: "Unavailable" });
      const unreadable = await dispatchBrowserWork(environmentId, browserId, null, "history");
      expect(unreadable).toMatchObject({ ok: false, code: "ConversationChanged" });
    } finally {
      disconnectDesktopCatalog(owner);
    }
  });
});
