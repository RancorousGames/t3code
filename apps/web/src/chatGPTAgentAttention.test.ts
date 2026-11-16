// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { activateAgentAttention, activeAgentAttentionStack, cancelManualAgentAttention, changeAttention, latestAgentAttention, loadAgentAttention, openAgentAttention, openAgentAttentionRequest, rearmManualAgentAttention, requestAgentAttention } from "./chatGPTAgentAttention";

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

  it("jumps only to outstanding alerts, cycling to the next after Ctrl+S", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(100);
    requestAgentAttention("first", "session-a", "First");
    now.mockReturnValue(200);
    activateAgentAttention(["session-a"]);
    now.mockReturnValue(300);
    requestAgentAttention("second", "session-b", "Second");
    now.mockReturnValue(400);
    activateAgentAttention(["session-b"]);

    expect(latestAgentAttention()?.id).toBe("second");
    openAgentAttention(["session-b"]);
    expect(latestAgentAttention()?.id).toBe("first");
    changeAttention("first", "dismissed");
    expect(latestAgentAttention()).toBeUndefined();

    now.mockReturnValue(500);
    requestAgentAttention("third", "session-c", "Not ready yet");
    expect(latestAgentAttention()).toBeUndefined();
  });

  it("skips snoozed and missing sessions, and avoids navigating to historical receipts", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(100);
    requestAgentAttention("one", "session-a", "Alert A");
    now.mockReturnValue(200);
    activateAgentAttention(["session-a"]);
    now.mockReturnValue(300);
    requestAgentAttention("two", "deleted-session", "Alert B");
    now.mockReturnValue(400);
    activateAgentAttention(["deleted-session"]);
    expect(latestAgentAttention()?.id).toBe("two");
    expect(latestAgentAttention(new Set(["session-a"]))?.id).toBe("one");

    changeAttention("one", "snoozed", 10_000);
    expect(latestAgentAttention(new Set(["session-a"]))).toBeUndefined();
    now.mockReturnValue(10_000);
    expect(latestAgentAttention(new Set(["session-a"]))?.id).toBe("one");

    changeAttention("one", "opened");
    expect(latestAgentAttention(new Set(["session-a"]))).toBeUndefined();
  });

  it("uses a newest-first stack and opens exactly one request even for the same session", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    requestAgentAttention("manual", "session", "Return to Old - its response is ready.", "manual");
    now.mockReturnValue(2_000);
    requestAgentAttention("agent", "session", "Agent question", "agent");
    now.mockReturnValue(3_000);
    activateAgentAttention(["session"]);
    expect(activeAgentAttentionStack(loadAgentAttention()).map((item) => item.id))
      .toEqual(["agent", "manual"]);
    expect(latestAgentAttention()?.id).toBe("agent");

    expect(openAgentAttentionRequest("agent", ["another-session"])).toBeUndefined();
    expect(openAgentAttentionRequest("agent", ["session"])?.id).toBe("agent");
    expect(activeAgentAttentionStack(loadAgentAttention()).map((item) => item.id))
      .toEqual(["manual"]);
    expect(latestAgentAttention()?.id).toBe("manual");
    expect(openAgentAttentionRequest("agent", ["session"])).toBeUndefined();

    expect(openAgentAttentionRequest("manual", ["session"])?.source).toBe("manual");
    now.mockReturnValue(4_000);
    rearmManualAgentAttention(["session"], "Current session");
    expect(loadAgentAttention().find((item) => item.status === "waiting")?.message)
      .toBe("Current session");
    expect(activeAgentAttentionStack(loadAgentAttention())).toHaveLength(0);
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
