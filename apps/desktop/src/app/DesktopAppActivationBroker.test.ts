import { ProjectId, ThreadId, type DesktopAppActivationRequest } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";

const request: DesktopAppActivationRequest = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
};

describe("DesktopAppActivationBroker", () => {
  it("skips a busy recipient without passing a later global barrier", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 10_000, activate: vi.fn() });
    broker.registerRenderer(send);
    const a1 = {
      version: 1,
      requestId: "a1",
      type: "chatgpt.sessions",
      action: "send",
      sessionId: "a",
    } as const;
    const a2 = { ...a1, requestId: "a2" };
    const b = { ...a1, requestId: "b", sessionId: "b" };
    const c = { ...a1, requestId: "c", sessionId: "c" };
    const responses = [
      broker.request(a1),
      broker.request(a2),
      broker.request(b),
      broker.request(request),
      broker.request(c),
    ];
    const dispatched = () => send.mock.calls.map(([entry]) => entry.requestId);
    const complete = (requestId: string) =>
      broker.complete({
        version: 1,
        requestId,
        ok: false,
        code: "renderer-unavailable",
        message: "done",
      });

    expect(dispatched()).toEqual(["a1", "b"]);
    complete("b");
    expect(dispatched()).toEqual(["a1", "b"]);
    complete("a1");
    expect(dispatched()).toEqual(["a1", "b", "a2"]);
    complete("a2");
    expect(dispatched()).toEqual(["a1", "b", "a2", request.requestId]);
    complete(request.requestId);
    expect(dispatched()).toEqual(["a1", "b", "a2", request.requestId, "c"]);
    broker.close();
    await Promise.all(responses);
  });

  it("dispatches independent recipient requests concurrently while keeping global barriers", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 10_000, activate: vi.fn() });
    broker.registerRenderer(send);
    const a = {
      version: 1,
      requestId: "a",
      type: "chatgpt.sessions",
      action: "send",
      sessionId: "a",
    } as const;
    const b = { ...a, requestId: "b", sessionId: "b" };
    const first = broker.request(a);
    const second = broker.request(b);
    const barrier = broker.request(request);
    const later = broker.request({ ...a, requestId: "c", sessionId: "c" });
    expect(send.mock.calls.map(([r]) => r.requestId)).toEqual(["a", "b"]);
    broker.complete({
      version: 1,
      requestId: "a",
      ok: false,
      code: "renderer-unavailable",
      message: "done",
    });
    expect(send).toHaveBeenCalledTimes(2);
    broker.complete({
      version: 1,
      requestId: "b",
      ok: false,
      code: "renderer-unavailable",
      message: "done",
    });
    expect(send.mock.calls.map(([r]) => r.requestId)).toEqual(["a", "b", request.requestId]);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: false,
      code: "renderer-unavailable",
      message: "done",
    });
    expect(send).toHaveBeenCalledTimes(4);
    broker.close();
    await Promise.all([first, second, barrier, later]);
  });
  it("focuses immediately and waits for renderer readiness", async () => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });

    const response = broker.request(request);
    expect(activate).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();

    broker.registerRenderer(send);
    expect(send).toHaveBeenCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: true, projectId: "project-1" });
    broker.close();
  });

  it("does not restore a minimized window for background API or guest requests", async () => {
    const activate = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(vi.fn());

    const background: DesktopAppActivationRequest[] = [
      { version: 1, requestId: "threads-list", type: "t3.threads", action: "list" },
      { version: 1, requestId: "threads-read", type: "t3.threads", action: "read" },
      { version: 1, requestId: "threads-providers", type: "t3.threads", action: "providers" },
      { version: 1, requestId: "sessions-list", type: "chatgpt.sessions", action: "list" },
      { version: 1, requestId: "sessions-open", type: "chatgpt.sessions", action: "open" },
      { version: 1, requestId: "sessions-send", type: "chatgpt.sessions", action: "send" },
      { version: 1, requestId: "spawn", type: "chatgpt.spawn", title: "Agent", prompt: "Work" },
      { version: 1, requestId: "inbox", type: "openrig.human_inbox", action: "fetch_unread" },
    ];
    const replies = background.map((entry) => broker.request(entry));
    expect(activate).not.toHaveBeenCalled();

    replies.push(
      broker.request({
        version: 1,
        requestId: "focus-thread",
        type: "t3.threads",
        action: "focus",
      }),
    );
    replies.push(
      broker.request({
        version: 1,
        requestId: "focus-session",
        type: "chatgpt.sessions",
        action: "focus",
      }),
    );
    expect(activate).toHaveBeenCalledTimes(2);

    broker.close();
    await Promise.all(replies);
  });

  it("fails an in-flight request when the renderer goes away", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(vi.fn());

    const response = broker.request(request);
    broker.clearRenderer();

    await expect(response).resolves.toMatchObject({
      ok: false,
      code: "renderer-unavailable",
    });
    broker.close();
  });

  it("never sends a canceled request that was queued behind another request", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(send);
    const secondRequest = { ...request, requestId: "request-2" };

    const firstResponse = broker.request(request);
    const secondResponse = broker.request(secondRequest);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(request);

    broker.cancel(secondRequest.requestId);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(firstResponse).resolves.toMatchObject({ ok: true });
    await expect(secondResponse).resolves.toMatchObject({ ok: false });
    expect(send).toHaveBeenCalledTimes(1);
    broker.close();
  });
});

describe("side-effecting renderer handoff receipts", () => {
  const spawn: DesktopAppActivationRequest = {
    version: 1,
    requestId: "spawn-detached",
    type: "chatgpt.spawn",
    title: "Isolated child",
    prompt: "Carry out the task",
  };

  it("keeps a dispatched spawn pending across renderer loss and accepts a late CREATED receipt", async () => {
    vi.useFakeTimers();
    try {
      const broker = new DesktopAppActivationBroker({
        requestTimeoutMs: 100,
        chatGPTRequestTimeoutMs: 1_000,
        activate: vi.fn(),
      });
      const firstRenderer = vi.fn();
      const replacement = vi.fn();
      broker.registerRenderer(firstRenderer);
      const pending = broker.request(spawn);
      broker.clearRenderer();
      broker.registerRenderer(replacement);
      expect(firstRenderer).toHaveBeenCalledOnce();
      expect(replacement).not.toHaveBeenCalled();
      broker.complete({
        version: 1,
        requestId: spawn.requestId,
        ok: true,
        sessionId: "created-before-detach",
        messageSent: true,
      });
      await expect(pending).resolves.toMatchObject({
        ok: true,
        sessionId: "created-before-detach",
        messageSent: true,
      });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports UNKNOWN after dispatched spawn times out, never says it was not created or replays it", async () => {
    vi.useFakeTimers();
    try {
      const broker = new DesktopAppActivationBroker({
        requestTimeoutMs: 100,
        chatGPTRequestTimeoutMs: 1_000,
        activate: vi.fn(),
      });
      const firstRenderer = vi.fn();
      const replacement = vi.fn();
      broker.registerRenderer(firstRenderer);
      const pending = broker.request(spawn);
      broker.clearRenderer();
      broker.registerRenderer(replacement);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: "request-timeout",
        message: expect.stringContaining("Outcome UNKNOWN"),
      });
      expect(firstRenderer).toHaveBeenCalledOnce();
      expect(replacement).not.toHaveBeenCalled();
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay a possibly dispatched send even when the renderer transport throws", async () => {
    vi.useFakeTimers();
    try {
      const broker = new DesktopAppActivationBroker({
        requestTimeoutMs: 100,
        chatGPTRequestTimeoutMs: 500,
        activate: vi.fn(),
      });
      const sent = vi.fn(() => {
        throw new Error("bridge disconnected");
      });
      broker.registerRenderer(sent);
      const pending = broker.request({
        version: 1,
        requestId: "send-detached",
        type: "chatgpt.sessions",
        action: "send",
        sessionId: "existing",
        message: "Only once",
      });
      const next = vi.fn();
      broker.registerRenderer(next);
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: "request-timeout",
        message: expect.stringContaining("Outcome UNKNOWN"),
      });
      expect(sent).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("distinguishes a queued command never dispatched from an unknown dispatched result", async () => {
    vi.useFakeTimers();
    try {
      const broker = new DesktopAppActivationBroker({
        requestTimeoutMs: 100,
        chatGPTRequestTimeoutMs: 500,
        activate: vi.fn(),
      });
      const pending = broker.request(spawn);
      await vi.advanceTimersByTimeAsync(500);
      const response = await pending;
      expect(response).toMatchObject({ ok: false, code: "request-timeout" });
      if (!response.ok) expect(response.message).not.toContain("Outcome UNKNOWN");
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dispatched cancellation is not proof of non-delivery", () => {
  it("labels the canceled side-effecting request UNKNOWN without retry", async () => {
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    const send = vi.fn();
    broker.registerRenderer(send);
    const request: DesktopAppActivationRequest = {
      version: 1,
      requestId: "cancel-after-dispatch",
      type: "chatgpt.spawn",
      title: "Child",
      prompt: "Run exactly once",
    };
    const pending = broker.request(request);
    broker.cancel(request.requestId);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "renderer-unavailable",
      message: expect.stringContaining("Outcome UNKNOWN"),
    });
    expect(send).toHaveBeenCalledOnce();
    broker.close();
  });
});

describe("ChatGPT close reconciliation bypasses slow guest operations", () => {
  it("dispatches status and list while close remains in-flight without replaying close", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({
      requestTimeoutMs: 5_000,
      chatGPTRequestTimeoutMs: 5_000,
      activate: vi.fn(),
    });
    broker.registerRenderer(send);
    const closedId = "e94b2d0f-99cd-4bad-a7d8-c23c72d206de";
    const close = {
      version: 1 as const,
      requestId: "slow-close",
      type: "chatgpt.sessions" as const,
      action: "change_state" as const,
      state: "closed" as const,
      sessionId: closedId,
    };
    const status = {
      version: 1 as const,
      requestId: "status",
      type: "chatgpt.sessions" as const,
      action: "close_status" as const,
      sessionId: closedId,
    };
    const list = {
      version: 1 as const,
      requestId: "list",
      type: "chatgpt.sessions" as const,
      action: "list" as const,
      which: "all" as const,
    };
    const closeReply = broker.request(close);
    const statusReply = broker.request(status);
    const listReply = broker.request(list);
    expect(send.mock.calls.map(([request]) => request.requestId)).toEqual([
      "slow-close",
      "status",
      "list",
    ]);
    broker.complete({
      version: 1,
      requestId: "status",
      ok: true,
      data: {
        action: "close_status",
        sessionId: closedId,
        status: "open",
        persisted: false,
      },
    });
    broker.complete({ version: 1, requestId: "list", ok: true, data: { sessions: [], total: 0 } });
    await expect(statusReply).resolves.toMatchObject({ ok: true });
    await expect(listReply).resolves.toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledTimes(3);
    broker.complete({
      version: 1,
      requestId: "slow-close",
      ok: true,
      data: {
        action: "change_state",
        sessionId: closedId,
        state: "closed",
        acknowledged: true,
        persisted: true,
      },
    });
    await expect(closeReply).resolves.toMatchObject({ ok: true });
    broker.close();
  });
});
