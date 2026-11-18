// @vitest-environment node
import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { inspect, send } = vi.hoisted(() => ({
  inspect: vi.fn(),
  send: vi.fn(),
}));
vi.mock("./chatGPTSessionControl", () => ({
  inspectBrowserSession: inspect,
  runChatGPTSessionControl: send,
  hasUncertainChatGPTSend: () => false,
}));

import {
  deliverNextChatGPTSessionMessage,
  queueChatGPTSessionMessage,
  shouldReleaseCapacityAfterIdle,
} from "./chatGPTSessionMessageQueue";

const environmentId = EnvironmentId.make("queue-test");
const sessionId = "e6eecbfb-8653-4c0e-a5b0-3da0f436762f";
const sessions = [{ id: sessionId, title: "Worker" }] as Parameters<typeof deliverNextChatGPTSessionMessage>[2];
const key = `t3code:chatgpt-browser:session-queue:v1:${environmentId}:${sessionId}`;
const pending = () => JSON.parse(localStorage.getItem(key) ?? "[]") as { id: string; state: string; text: string }[];

beforeEach(() => {
  const values = new Map<string, string>();
  const store = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, value); },
    removeItem: (name: string) => { values.delete(name); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  vi.stubGlobal("localStorage", store);
  vi.stubGlobal("sessionStorage", store);
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), localStorage: store,
    sessionStorage: store, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("CustomEvent", class { constructor(_type: string, _init: unknown) {} });
  inspect.mockReset();
  send.mockReset();
});

describe("ChatGPT Session Queue", () => {
  it("never releases an admitted worker slot merely because a user turn was delivered", () => {
    const row = { id: "x", text: "Work", conversationId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      condition: "wait_for_slot" as const, state: "delivered" as const,
      createdAt: 0, updatedAt: 0, capacitySubmittedAt: 1000 };
    const event = { environmentId, sessionId,
      conversationId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      eventId: "evt", sequence: 1, bindingRevision: null, observedAt: 1001, turnCount: 2 };
    const { capacitySubmittedAt: _submittedAt, ...notSubmitted } = row;
    expect(shouldReleaseCapacityAfterIdle(notSubmitted, event)).toBe(false);
    expect(shouldReleaseCapacityAfterIdle(row, { ...event, observedAt: 999 })).toBe(false);
    expect(shouldReleaseCapacityAfterIdle(row, { ...event,
      conversationId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" })).toBe(false);
    expect(shouldReleaseCapacityAfterIdle(row, event)).toBe(true);
    expect(shouldReleaseCapacityAfterIdle({ ...row, capacityReleasedAt: 1005 }, event)).toBe(false);
  });
  it("deduplicates question answers by stable message ID even after a failed acknowledgement", () => {
    const id = "a0d1357c-4c8b-462f-86e1-d7f5e1578220";
    expect(queueChatGPTSessionMessage(environmentId, sessionId, "Answer: A", null, id)).toBe(id);
    expect(queueChatGPTSessionMessage(environmentId, sessionId, "Answer: A", null, id)).toBe(id);
    expect(pending()).toHaveLength(1);
    expect(() => queueChatGPTSessionMessage(environmentId, sessionId, "Answer: B", null, id))
      .toThrow(/conflicts/);
    expect(pending()).toHaveLength(1);
  });
  it("accepts before any page observation; waits for idle, then sends first prompt to new chat", async () => {
    queueChatGPTSessionMessage(environmentId, sessionId, "Start my task", null);
    inspect.mockResolvedValueOnce({ activity: "working", status: "working", conversationId: null })
      .mockResolvedValueOnce({ activity: "idle", status: "new", conversationId: null });
    send.mockResolvedValue({ delivery: "user_turn_observed", messageSent: true });
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(send).not.toHaveBeenCalled();
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      action: "send", sessionId, expectedNewChat: true,
    }));
    expect(pending()[0]?.state).toBe("delivered");
  });

  it("does not retarget a queued message when the browser switches conversations", async () => {
    queueChatGPTSessionMessage(environmentId, sessionId, "Review this", "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
    inspect.mockResolvedValue({ activity: "idle", status: "done_or_idle", conversationId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" });
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(send).not.toHaveBeenCalled();
    expect(pending()[0]?.state).toBe("needs_attention");
  });

  it("delivers a successor wake past messages refused for older conversations", async () => {
    const original = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const successor = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const old = queueChatGPTSessionMessage(environmentId, sessionId, "Old wake", original);
    inspect.mockResolvedValue({ activity: "idle", status: "done_or_idle", conversationId: successor });
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(pending().find(row => row.id === old)?.state).toBe("needs_attention");
    const older = queueChatGPTSessionMessage(environmentId, sessionId, "Another old wake", original);
    const wake = queueChatGPTSessionMessage(environmentId, sessionId, "Completed job", successor);
    send.mockResolvedValue({ delivery: "user_turn_observed", messageSent: true });
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    inspect.mockResolvedValue({ activity: "working", status: "working", conversationId: successor });
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(send).not.toHaveBeenCalled();
    inspect.mockResolvedValue({ activity: "idle", status: "done_or_idle", conversationId: successor });
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(pending().find(row => row.id === older)?.state).toBe("needs_attention");
    expect(pending().find(row => row.id === wake)?.state).toBe("delivered");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      expectedConversationId: successor, message: `[T3-MSG:${wake}]\nCompleted job`,
    }));
    inspect.mockResolvedValue({ activity: "idle", status: "done_or_idle", conversationId: original });
    queueChatGPTSessionMessage(environmentId, sessionId, "Later original message", original);
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["unknown", "needs_attention", "sending"])("preserves the %s fence before a successor wake", async (state) => {
    const old = queueChatGPTSessionMessage(environmentId, sessionId, "Unresolved", "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
    localStorage.setItem(key, JSON.stringify(pending().map(row => ({ ...row, state }))));
    const successor = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const wake = queueChatGPTSessionMessage(environmentId, sessionId, "Completed job", successor);
    inspect.mockResolvedValue({ activity: "idle", status: "done_or_idle", conversationId: successor });
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(send).not.toHaveBeenCalled();
    expect(pending().find(row => row.id === wake)?.state).toBe("queued");
    expect(pending().find(row => row.id === old)?.state).not.toBe("delivered");
  });

  it("reconciles a delivered user turn when ChatGPT leaves only an empty assistant placeholder", async () => {
    const conversationId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const id = queueChatGPTSessionMessage(environmentId, sessionId, "Clean up the dialog", conversationId);
    inspect.mockResolvedValue({
      activity: "idle", status: "pending_or_stalled", conversationId,
      messages: [
        { role: "user", text: `[T3-MSG:${id}]\nClean up the dialog` },
        { role: "assistant", text: "" },
      ],
    });
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(send).not.toHaveBeenCalled();
    expect(pending()[0]?.state).toBe("delivered");
  });

  it("recovers a lost send acknowledgement only from the exact original conversation", async () => {
    const conversationId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const id = queueChatGPTSessionMessage(environmentId, sessionId, "Original request", conversationId);
    localStorage.setItem(key, JSON.stringify(pending().map((row) => ({ ...row, state: "unknown" }))));
    inspect.mockResolvedValueOnce({
      activity: "idle", status: "done_or_idle",
      conversationId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      messages: [{ role: "user", text: `[T3-MSG:${id}]\nOriginal request` }],
    }).mockResolvedValueOnce({
      activity: "idle", status: "pending_or_stalled", conversationId,
      messages: [{ role: "user", text: `[T3-MSG:${id}]\nOriginal request` }],
    });
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(pending()[0]?.state).toBe("unknown");
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(pending()[0]?.state).toBe("delivered");
    expect(send).not.toHaveBeenCalled();
  });

  it("never resubmits an unconfirmed send without explicit reconciliation", async () => {
    queueChatGPTSessionMessage(environmentId, sessionId, "Important", "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
    inspect.mockResolvedValue({ activity: "idle", status: "done_or_idle", conversationId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" });
    send.mockResolvedValue({ delivery: "unknown", messageSent: false });
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(send).toHaveBeenCalledTimes(1);
    expect(pending()[0]?.state).toBe("unknown");
  });

  it("recovers an orphaned in-flight send as UNKNOWN on renderer reinitialization", async () => {
    const id = queueChatGPTSessionMessage(environmentId, sessionId, "Important", null);
    const rows = JSON.parse(localStorage.getItem(key)!) as { id: string; state: string }[];
    localStorage.setItem(key, JSON.stringify(rows.map((row) => ({ ...row, state: "sending" }))));
    await deliverNextChatGPTSessionMessage(environmentId, sessionId, sessions);
    expect(send).not.toHaveBeenCalled();
    expect(pending().find((row) => row.id === id)?.state).toBe("unknown");
  });
});
