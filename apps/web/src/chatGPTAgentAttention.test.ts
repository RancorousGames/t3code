// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { activateAgentAttention, cancelManualAgentAttention, latestAgentAttention, loadAgentAttention, openAgentAttention, rearmManualAgentAttention, requestAgentAttention } from "./chatGPTAgentAttention";

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

  it("rearms Ctrl+D after each acknowledgement without resetting agent one-time requests", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    requestAgentAttention("manual", "session", "Come back", "manual");
    requestAgentAttention("agent", "session", "Question");
    activateAgentAttention(["session"]);
    expect(loadAgentAttention().filter((item) => item.status === "pending")).toHaveLength(2);

    openAgentAttention(["session"]);
    now.mockReturnValue(2_000);
    rearmManualAgentAttention(["session"]);
    const waiting = loadAgentAttention().filter((item) => item.status === "waiting");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ source: "manual", sessionId: "session" });
    expect(waiting[0]?.id).not.toBe("manual");
    expect(loadAgentAttention().find((item) => item.id === "agent")?.status).toBe("opened");

    now.mockReturnValue(3_000);
    activateAgentAttention(["session"]);
    const newlyPending = loadAgentAttention().filter((item) => item.status === "pending");
    expect(newlyPending).toHaveLength(1);
    expect(newlyPending[0]?.id).toBe(waiting[0]?.id);
    cancelManualAgentAttention(["session"]);
    expect(loadAgentAttention().filter((item) => item.status === "pending")).toHaveLength(0);
    expect(loadAgentAttention().find((item) => item.id === "agent")?.status).toBe("opened");
  });

  it("turning Ctrl+D off does not cancel an agent's pending attention", () => {
    requestAgentAttention("manual", "session", "Watch", "manual");
    requestAgentAttention("agent", "session", "Need help");
    activateAgentAttention(["session"]);
    cancelManualAgentAttention(["session"]);
    expect(loadAgentAttention().find((item) => item.id === "manual")?.status).toBe("dismissed");
    expect(loadAgentAttention().find((item) => item.id === "agent")?.status).toBe("pending");
  });
});
