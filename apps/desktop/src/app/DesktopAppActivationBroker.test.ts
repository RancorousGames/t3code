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

  it("queues requests after unsubscribe until a new renderer registers", async () => {
    const previousSend = vi.fn();
    const nextSend = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
    broker.registerRenderer(previousSend);
    broker.clearRenderer();

    const response = broker.request(request);
    expect(previousSend).not.toHaveBeenCalled();
    expect(nextSend).not.toHaveBeenCalled();

    broker.registerRenderer(nextSend);
    expect(nextSend).toHaveBeenCalledWith(request);
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });

    await expect(response).resolves.toMatchObject({ ok: true });
    broker.close();
  });

  it("removes a queued request when its CLI connection closes", async () => {
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });

    const response = broker.request(request);
    broker.cancel(request.requestId);
    broker.registerRenderer(send);

    await expect(response).resolves.toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(send).not.toHaveBeenCalled();
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

  it("spawns ChatGPT in the already-running renderer without activating or focusing T3", async () => {
    const activate = vi.fn();
    const send = vi.fn();
    const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate });
    broker.registerRenderer(send);
    const spawn: DesktopAppActivationRequest = {
      version: 1,
      requestId: "background-agent",
      type: "chatgpt.spawn",
      title: "Background agent",
      prompt: "Work while I continue using T3",
    };

    const response = broker.request(spawn);
    expect(activate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(spawn);

    broker.complete({
      version: 1,
      requestId: spawn.requestId,
      ok: true,
      sessionId: "new-background-session",
      messageSent: true,
    });
    await expect(response).resolves.toMatchObject({
      ok: true,
      sessionId: "new-background-session",
      messageSent: true,
    });

    // Other desktop commands continue using the existing foreground behavior.
    const workspaceResponse = broker.request(request);
    expect(activate).toHaveBeenCalledOnce();
    broker.complete({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
    });
    await workspaceResponse;
    broker.close();
  });

  it("allows a longer window for ChatGPT browser startup without changing workspace timeouts", async () => {
    vi.useFakeTimers();
    try {
      const broker = new DesktopAppActivationBroker({
        requestTimeoutMs: 1_000,
        chatGPTRequestTimeoutMs: 5_000,
        activate: vi.fn(),
      });
      const request = {
        version: 1 as const,
        requestId: "chatgpt-spawn-test",
        type: "chatgpt.spawn" as const,
        title: "Reviewer",
        prompt: "Review the spec",
      };
      const response = broker.request(request);
      await vi.advanceTimersByTimeAsync(2_000);
      broker.complete({
        version: 1,
        requestId: request.requestId,
        ok: true,
        sessionId: "browser-session-1",
        messageSent: true,
      });
      await expect(response).resolves.toMatchObject({
        ok: true,
        sessionId: "browser-session-1",
        messageSent: true,
      });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a request without polling", async () => {
    vi.useFakeTimers();
    try {
      const broker = new DesktopAppActivationBroker({ requestTimeoutMs: 1_000, activate: vi.fn() });
      const response = broker.request(request);

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(response).resolves.toMatchObject({ ok: false, code: "request-timeout" });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
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
