// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { activateAgentAttention, latestAgentAttention, requestAgentAttention } from "./chatGPTAgentAttention";

const saved = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => { saved.set(key, value); },
});
vi.stubGlobal("window", { dispatchEvent: vi.fn() });
afterEach(() => { saved.clear(); vi.restoreAllMocks(); });

describe("Ctrl+S attention target", () => {
  it("uses the most recently activated request, not the newest armed one", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(100);
    requestAgentAttention("a", "session-a", "A");
    now.mockReturnValue(200);
    requestAgentAttention("b", "session-b", "B");
    now.mockReturnValue(300);
    activateAgentAttention(["session-b"]);
    expect(latestAgentAttention()?.sessionId).toBe("session-b");

    now.mockReturnValue(400);
    activateAgentAttention(["session-a"]);
    expect(latestAgentAttention()?.sessionId).toBe("session-a");

    now.mockReturnValue(500);
    requestAgentAttention("c", "session-c", "C");
    expect(latestAgentAttention()?.sessionId).toBe("session-a");
  });
});
