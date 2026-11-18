import { describe, expect, it, vi } from "vite-plus/test";
import { queueAgentAttentionDismissal } from "./chatGPTAttentionHandoff";
import type { AgentAttention } from "./chatGPTAgentAttention";

describe("attention dismissal handoff", () => {
  it("does not send an automated agent message for a persistent Ctrl+D reminder", async () => {
    const enqueueChatGPT = vi.fn();
    vi.stubGlobal("window", { desktopBridge: { appActivation: { enqueueChatGPT } } });
    const manual: AgentAttention = {
      id: "persistent", sessionId: "session", message: "User-set reminder",
      source: "manual", status: "pending", createdAt: 100, nextAt: 100,
    };
    expect(await queueAgentAttentionDismissal("environment", manual)).toBe(true);
    expect(enqueueChatGPT).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
