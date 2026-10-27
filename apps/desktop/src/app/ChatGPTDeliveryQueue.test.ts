// @effect-diagnostics nodeBuiltinImport:off -- Temporary filesystem fixtures for the durable outbox.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "@t3tools/contracts";
import { ChatGPTDeliveryQueue } from "./ChatGPTDeliveryQueue.ts";

type Request = Extract<DesktopAppActivationRequest, { type: "chatgpt.sessions" }>;
const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const conversationId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const anotherConversation = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const input = { messageId: id, sessionId: "browser-B", conversationId, body: "Next game turn" };
const dirs: string[] = [];
const makeDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-delivery-"));
  dirs.push(dir);
  return dir;
};
const observed = (
  request: DesktopAppActivationRequest,
  verifiedConversationId = conversationId,
): DesktopAppActivationResponse => ({
  version: 1,
  requestId: request.requestId,
  ok: true,
  data: {
    messageSent: true,
    delivery: "user_turn_observed",
    conversationGuardValidated: true,
    verifiedConversationId,
  },
});
const failure = (
  request: DesktopAppActivationRequest,
  message: string,
): DesktopAppActivationResponse => ({
  version: 1,
  requestId: request.requestId,
  ok: false,
  code: "chatgpt-send-failed",
  message,
});
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("durable ChatGPT delivery queue", () => {
  it("rotates available conversation slots when earlier lanes remain busy", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const requests: Request[] = [];
    const pending: Array<() => void> = [];
    const queue = new ChatGPTDeliveryQueue(makeDir(), (request) => {
      if (request.type !== "chatgpt.sessions") throw Error("wrong route");
      requests.push(request);
      return new Promise((resolve) => pending.push(() => resolve(failure(request, "not observable"))));
    });
    for (let n = 1; n <= 6; n++) {
      const uuid = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      queue.enqueue({ messageId: uuid, conversationId: uuid, sessionId: uuid, body: "message" });
    }
    const first = queue.pulse();
    expect(requests).toHaveLength(4);
    for (const resolve of pending) resolve();
    await first;
    now += 61_000;
    const next = queue.pulse();
    expect(requests[4]?.sessionId).toBe("00000000-0000-4000-8000-000000000005");
    for (const resolve of pending.slice(4)) resolve();
    await next;
    queue.close();
    clock.mockRestore();
  });
  it("persists before acknowledging, deduplicates callers and keeps journal insertion order", () => {
    const dir = makeDir();
    const sender = vi.fn(
      async (_request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> => {
        throw Error("should not send until started");
      },
    );
    const first = new ChatGPTDeliveryQueue(dir, sender);
    expect(first.enqueue(input).status).toBe("queued");
    expect(first.enqueue(input).messageId).toBe(id);
    expect(() => first.enqueue({ ...input, body: "Different" })).toThrow("already belongs");
    first.enqueue({ ...input, messageId: anotherConversation, body: "Later turn" });
    const order = first.list().map((r) => r.messageId);
    first.close();
    const second = new ChatGPTDeliveryQueue(dir, sender);
    expect(second.list().map((r) => r.messageId)).toEqual(order);
    expect(second.diagnose(conversationId).oldestMessageId).toBe(id);
    second.close();
    expect(sender).not.toHaveBeenCalled();
  });

  it("reconciles lost IPC acknowledgement on restart without issuing a second send", async () => {
    const dir = makeDir();
    const firstSender = vi.fn(async () => {
      throw Error("lost IPC acknowledgement");
    });
    const first = new ChatGPTDeliveryQueue(dir, firstSender);
    first.enqueue(input);
    await first.pulse();
    expect(first.status(id).status).toBe("uncertain");
    first.close();
    const recover = vi.fn(
      async (request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> =>
        observed(request),
    );
    const second = new ChatGPTDeliveryQueue(dir, recover);
    await second.pulse();
    expect(recover.mock.calls.map(([r]) => (r as Request).action)).toEqual(["reconcile_send"]);
    expect(second.status(id).status).toBe("delivered");
    second.close();
  });

  it("only the original renderer's verified no-click/no-attempt receipt permits retry", async () => {
    const dir = makeDir();
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const calls: Request[] = [];
    const sender = vi.fn(
      async (request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> => {
        if (request.type !== "chatgpt.sessions") throw Error("wrong request");
        calls.push(request);
        if (calls.length === 1) throw Error("renderer ack timed out");
        if (calls.length === 2)
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            data: {
              delivery: "pre_submit_aborted",
              messageSent: false,
              sendAttempted: false,
              conversationGuardValidated: true,
              verifiedConversationId: conversationId,
            },
          };
        return observed(request);
      },
    );
    try {
      const queue = new ChatGPTDeliveryQueue(dir, sender);
      queue.enqueue(input);
      await queue.pulse();
      const deadline = calls[0]?.sendExpiresAt;
      expect(deadline).toBe(now + 70_000);
      now = deadline! + 6_000;
      await queue.pulse();
      expect(queue.status(id).status).toBe("queued");
      expect(calls.map((r) => r.action)).toEqual(["send", "reconcile_send"]);
      now += 3_001;
      await queue.pulse();
      expect(queue.status(id).status).toBe("delivered");
      expect(calls.map((r) => r.action)).toEqual(["send", "reconcile_send", "send"]);
      expect(calls[0]?.message).toBe(calls[2]?.message);
      queue.close();
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps FIFO during reconciliation and drains after observing the original send", async () => {
    const dir = makeDir();
    let now = 3_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const later = Array.from(
      { length: 42 },
      (_, n) => `00000000-0000-4000-8000-${(n + 1).toString().padStart(12, "0")}`,
    );
    try {
      const initial = new ChatGPTDeliveryQueue(dir, async () => {
        throw Error("lost ack after Enter");
      });
      initial.enqueue(input);
      for (const messageId of later)
        initial.enqueue({ ...input, messageId, body: `Private message ${messageId}` });
      await initial.pulse();
      expect(initial.status(id).status).toBe("uncertain");
      expect(initial.diagnose(conversationId, now + 1000)).toMatchObject({
        oldestMessageId: id,
        oldestStatus: "uncertain",
        oldestAgeMs: 1000,
        queuedBehind: 42,
        pending: 43,
      });
      expect(JSON.stringify(initial.diagnose(conversationId))).not.toContain("Private message");
      initial.close();

      const calls: Request[] = [];
      let acknowledged = false;
      const sender = vi.fn(
        async (request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> => {
          if (request.type !== "chatgpt.sessions") throw Error("wrong route");
          calls.push(request);
          if (request.action === "reconcile_send" && !acknowledged)
            return failure(request, "Original user message not observable");
          return observed(request);
        },
      );
      const reopened = new ChatGPTDeliveryQueue(dir, sender);
      now += 120_000;
      await reopened.pulse();
      expect(reopened.status(id).status).toBe("uncertain");
      expect(reopened.diagnose(conversationId).queuedBehind).toBe(42);
      expect(calls.filter((r) => r.action === "send")).toHaveLength(0);
      reopened.close();

      const again = new ChatGPTDeliveryQueue(dir, sender);
      acknowledged = true;
      await again.pulse();
      expect(again.status(id).status).toBe("delivered");
      expect(again.diagnose(conversationId).oldestMessageId).toBe(later[0]);
      // Every next pulse takes only one journal head: no same-conversation parallelism.
      for (const messageId of later) {
        await again.pulse();
        expect(again.status(messageId).status).toBe("delivered");
      }
      expect(again.diagnose(conversationId).blocked).toBe(false);
      expect(calls.map((r) => r.action)).toEqual([
        "reconcile_send",
        "reconcile_send",
        ...later.map(() => "send"),
      ]);
      expect(
        calls
          .filter((r) => r.action === "send")
          .map((r) => /\[T3-MSG:([^\]]+)\]/.exec(r.message ?? "")?.[1]),
      ).toEqual(later);
      again.close();
    } finally {
      clock.mockRestore();
    }
  });

  it("never treats bare messageSent or wrong conversation as delivery evidence", async () => {
    const dir = makeDir();
    let calls = 0;
    const sender = vi.fn(
      async (request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> => {
        calls++;
        if (calls === 1)
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            data: { delivery: "unknown", messageSent: true },
          };
        return observed(request, anotherConversation);
      },
    );
    const queue = new ChatGPTDeliveryQueue(dir, sender);
    queue.enqueue(input);
    await queue.pulse();
    expect(queue.status(id).status).toBe("uncertain");
    queue.close();
    const restored = new ChatGPTDeliveryQueue(dir, sender);
    await restored.pulse();
    expect(restored.status(id).status).toBe("uncertain");
    expect(sender.mock.calls.map(([r]) => (r as Request).action)).toEqual([
      "send",
      "reconcile_send",
    ]);
    restored.close();
  });

  it("A focused composer never blocks idle B; B focused, drafting, pending or cold blocks only B", async () => {
    let now = 5_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const cases = ["focused", "draft", "pending", "cold"] as const;
      for (const state of cases) {
        const dir = makeDir();
        const requests: Request[] = [];
        let bState: string = state;
        const sender = async (
          request: DesktopAppActivationRequest,
        ): Promise<DesktopAppActivationResponse> => {
          if (request.type !== "chatgpt.sessions") throw Error("wrong route");
          requests.push(request);
          if (request.expectedConversationId === conversationId) {
            if (bState === "focused")
              return failure(request, "User-focused composer before typing; no message sent.");
            if (bState === "draft")
              return failure(
                request,
                "Composer contains an existing draft; refusing to overwrite it.",
              );
            if (bState === "pending")
              return failure(request, "Cannot send while session is not confirmed idle.");
            if (bState === "cold") return failure(request, "ChatGPT guest is not attached.");
          }
          return observed(request, request.expectedConversationId);
        };
        const queue = new ChatGPTDeliveryQueue(dir, sender);
        queue.enqueue({
          ...input,
          messageId: anotherConversation,
          sessionId: "browser-A",
          conversationId: anotherConversation,
          body: "Unrelated A",
        });
        queue.enqueue(input);
        await queue.pulse();
        expect(queue.status(anotherConversation).status).toBe("delivered");
        expect(queue.status(id).status).toBe("queued");
        expect(requests.map((r) => r.expectedConversationId)).toEqual([
          anotherConversation,
          conversationId,
        ]);
        expect(queue.diagnose(conversationId)).toMatchObject({
          oldestMessageId: id,
          reason: {
            focused: "composer_user_focused",
            draft: "recipient_draft_present",
            pending: "recipient_not_confirmed_idle",
            cold: "guest_unmounted",
          }[state],
        });
        bState = "idle";
        now += 61_000;
        await queue.pulse();
        expect(queue.status(id).status).toBe("delivered");
        expect(
          requests.filter(
            (r) => r.expectedConversationId === conversationId && r.action === "send",
          ),
        ).toHaveLength(2);
        queue.close();
      }
      // User typing into A must never be projected onto B: A defers, B sends once.
      const dir = makeDir();
      const requests: Request[] = [];
      const queue = new ChatGPTDeliveryQueue(dir, async (request) => {
        if (request.type !== "chatgpt.sessions") throw Error("wrong route");
        requests.push(request);
        return request.expectedConversationId === anotherConversation
          ? failure(request, "User-focused composer before typing; no message sent.")
          : observed(request);
      });
      queue.enqueue({
        ...input,
        messageId: anotherConversation,
        conversationId: anotherConversation,
        sessionId: "browser-A",
        body: "A human draft",
      });
      queue.enqueue(input);
      await queue.pulse();
      expect(queue.status(anotherConversation).status).toBe("queued");
      expect(queue.status(id).status).toBe("delivered");
      expect(requests.filter((r) => r.expectedConversationId === conversationId)).toHaveLength(1);
      queue.close();
    } finally {
      clock.mockRestore();
    }
  });

  it("focus change defers B, then a reconciled bounded retry recovers a lost acknowledgement", async () => {
    const dir = makeDir();
    let now = 9_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      let bFocused = false;
      let sendCalls = 0;
      const sender = vi.fn(
        async (request: DesktopAppActivationRequest): Promise<DesktopAppActivationResponse> => {
          if (request.type !== "chatgpt.sessions") throw Error("wrong route");
          if (request.action === "send") {
            sendCalls++;
            if (sendCalls === 1) {
              // Focus moves to B after preflight; the recipient-only final guard refuses.
              bFocused = true;
            }
            if (bFocused)
              return failure(request, "User-focused composer before typing; no message sent.");
            if (sendCalls === 2) throw Error("Enter may have occurred; IPC lost");
            return observed(request);
          }
          return failure(request, "Original user turn not observable; outcome indeterminate.");
        },
      );
      const queue = new ChatGPTDeliveryQueue(dir, sender);
      queue.enqueue(input);
      await queue.pulse();
      expect(queue.status(id).status).toBe("queued");
      now += 61_000;
      bFocused = false;
      await queue.pulse();
      expect(queue.status(id).status).toBe("uncertain");
      now += 10 * 60_000;
      await queue.pulse();
      expect(queue.status(id).status).toBe("delivered");
      expect(sendCalls).toBe(3);
      expect(sender.mock.calls.map(([r]) => (r as Request).action)).toEqual([
        "send",
        "send",
        "reconcile_send",
        "send",
      ]);
      queue.close();
    } finally {
      clock.mockRestore();
    }
  });
  it("keeps ambiguous messages in order and retries after long outages across restart", async () => {
    let now = 10_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const dir = makeDir();
    const calls: Request[] = [];
    let originalObserved = false;
    const sender = async (request: DesktopAppActivationRequest) => {
      if (request.type !== "chatgpt.sessions") throw Error("wrong route");
      calls.push(request);
      if (request.message?.includes(MARKER_ID) && !originalObserved)
        return failure(request, "Original user turn not observed.");
      return observed(request);
    };
    const MARKER_ID = `[T3-MSG:${id}]`;
    try {
      let queue = new ChatGPTDeliveryQueue(dir, sender);
      queue.enqueue(input);
      queue.enqueue({
        ...input,
        messageId: anotherConversation,
        body: "Later independent message",
      });
      await queue.pulse();
      now += 4 * 60_000;
      await queue.pulse();
      expect(calls.filter((r) => r.action === "send")).toHaveLength(1);
      now += 60_000;
      await queue.pulse();
      expect(queue.status(id).duplicateResends).toBe(1);
      expect(calls.at(-1)).toMatchObject({ action: "send", allowPossibleDuplicate: true });
      expect(calls.at(-1)?.message).toContain("Potential duplicate");
      expect(calls.at(-1)?.message).toContain(MARKER_ID);
      queue.close();
      queue = new ChatGPTDeliveryQueue(dir, sender);
      now += 10 * 60_000;
      await queue.pulse();
      expect(queue.status(id).duplicateResends).toBe(2);
      now += 2 * 60_000;
      await queue.pulse();
      expect(queue.status(id).status).toBe("uncertain");
      expect(queue.status(anotherConversation).status).toBe("queued");
      expect(queue.diagnose(conversationId)).toMatchObject({ blocked: true, queuedBehind: 1 });
      queue.close();
      queue = new ChatGPTDeliveryQueue(dir, sender);
      now += 24 * 60 * 60_000;
      await queue.pulse();
      expect(
        calls.filter((r) => r.action === "send" && r.message?.includes(MARKER_ID)),
      ).toHaveLength(4);
      originalObserved = true;
      now += 60_000;
      await queue.pulse();
      expect(queue.status(id).status).toBe("delivered");
      await queue.pulse();
      expect(queue.status(anotherConversation).status).toBe("delivered");
      queue.close();
    } finally {
      clock.mockRestore();
    }
  });

  it("does not spend retry budget or forget the original ambiguity when preflight refuses a retry", async () => {
    let now = 20_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let refusal = true;
    const queue = new ChatGPTDeliveryQueue(makeDir(), async (request) => {
      if (request.type !== "chatgpt.sessions") throw Error("wrong route");
      if (request.allowPossibleDuplicate)
        return refusal
          ? failure(request, "Composer contains an existing draft; refusing to overwrite it.")
          : observed(request);
      return failure(request, "Outcome UNKNOWN: IPC response lost.");
    });
    try {
      queue.enqueue(input);
      await queue.pulse();
      now += 5 * 60_000;
      await queue.pulse();
      expect(queue.status(id)).toMatchObject({ status: "uncertain", duplicateResends: 0 });
      refusal = false;
      now += 15_000;
      await queue.pulse();
      expect(queue.status(id)).toMatchObject({ status: "delivered", duplicateResends: 1 });
    } finally {
      queue.close();
      clock.mockRestore();
    }
  });

  it.each([
    "Queued delivery expired during renderer preflight; no message sent.",
    "ChatGPT conversation not yet mounted with verified messages; original session retained, no message sent.",
    "ChatGPT session registry is not hydrated; no message sent.",
    "ChatGPT guest is not attached",
    "ChatGPT page is unavailable before typing; no message sent.",
    "Conversation is not confirmed idle; refusing to send into pending/working/blocked thread.",
  ])("keeps a definite pre-submit refusal queued: %s", async (message) => {
    const queue = new ChatGPTDeliveryQueue(makeDir(), async (request) => failure(request, message));
    queue.enqueue(input);
    await queue.pulse();
    expect(queue.status(id)).toMatchObject({ status: "queued", duplicateResends: 0 });
    queue.close();
  });

  it("recovers exhausted attention after restart without resetting the resend schedule", async () => {
    let now = 40_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const dir = makeDir();
    const journal = NodePath.join(dir, "chatgpt-deliveries-v1.json");
    NodeFS.writeFileSync(journal, JSON.stringify([{
      ...input, status: "needs_attention", attempts: 5, duplicateResends: 2,
      lastSubmissionAt: now, uncertainSince: now - 20 * 60_000,
      createdAt: now - 20 * 60_000, updatedAt: now,
      lastError: "Delivery remains unconfirmed after two retries; Outcome UNKNOWN",
    }]));
    const calls: Request[] = [];
    const sender = async (request: DesktopAppActivationRequest) => {
      if (request.type !== "chatgpt.sessions") throw Error("wrong route");
      calls.push(request);
      return request.action === "send" ? observed(request) : failure(request, "Not observed");
    };
    try {
      let queue = new ChatGPTDeliveryQueue(dir, sender);
      expect(queue.status(id)).toMatchObject({ status: "uncertain", duplicateResends: 2 });
      await queue.pulse();
      queue.close();
      queue = new ChatGPTDeliveryQueue(dir, sender);
      now += 14 * 60_000;
      await queue.pulse();
      expect(calls.filter((r) => r.action === "send")).toHaveLength(0);
      now += 60_000;
      await queue.pulse();
      expect(queue.status(id)).toMatchObject({ status: "delivered", duplicateResends: 3 });
      expect(calls.at(-1)?.message).toContain(`[T3-MSG:${id}]`);
      queue.close();
    } finally {
      clock.mockRestore();
    }
  });

  it("drops missing recipients durably while other messages progress", async () => {
    const dir = makeDir();
    const calls: Request[] = [];
    const sender = async (request: DesktopAppActivationRequest) => {
      if (request.type !== "chatgpt.sessions") throw Error("wrong route");
      calls.push(request);
      if (request.expectedConversationId === conversationId)
        return failure(request, "T3 browser session is missing; original recipient retained, no message sent.");
      return observed(request, request.expectedConversationId);
    };
    let queue = new ChatGPTDeliveryQueue(dir, sender);
    const secondId = "dddddddd-dddd-4ddd-addd-dddddddddddd";
    queue.enqueue(input);
    queue.enqueue({ ...input, messageId: secondId });
    queue.enqueue({ ...input, messageId: anotherConversation, conversationId: anotherConversation });
    await queue.pulse();
    await queue.pulse();
    expect(queue.status(id)).toMatchObject({ status: "cancelled", sessionId: input.sessionId,
      conversationId, lastError: "Delivery dropped: recipient session is missing; this attempt was not sent." });
    expect(queue.status(secondId).status).toBe("cancelled");
    expect(queue.status(anotherConversation).status).toBe("delivered");
    expect(queue.list().find((record) => record.messageId === id)).not.toHaveProperty("body");
    const updatedAt = queue.status(id).updatedAt;
    queue.close();
    queue = new ChatGPTDeliveryQueue(dir, sender);
    expect(queue.enqueue(input)).toMatchObject({ status: "cancelled", updatedAt });
    await queue.pulse();
    expect(calls).toHaveLength(3);
    queue.close();
  });

  it("drops a missing recipient during reconciliation without claiming the earlier send failed", async () => {
    const dir = makeDir();
    const sender = vi.fn(async (request: DesktopAppActivationRequest) =>
      failure(request, request.type === "chatgpt.sessions" && request.action === "send"
        ? "Outcome UNKNOWN" : "T3 browser session is missing; original recipient retained, no message sent."));
    let queue = new ChatGPTDeliveryQueue(dir, sender);
    queue.enqueue(input);
    await queue.pulse();
    expect(queue.status(id).status).toBe("uncertain");
    queue.close();
    queue = new ChatGPTDeliveryQueue(dir, sender);
    await queue.pulse();
    expect(queue.status(id)).toMatchObject({ status: "cancelled", lastError:
      "Delivery dropped: recipient session is missing; an earlier submission may have occurred." });
    queue.close();
    queue = new ChatGPTDeliveryQueue(dir, sender);
    await queue.pulse();
    expect(sender).toHaveBeenCalledTimes(2);
    queue.close();
  });

  it("keeps an unmounted registered recipient queued beyond thirty minutes", async () => {
    let now = 30_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const queue = new ChatGPTDeliveryQueue(makeDir(), async (request) =>
      failure(request, "ChatGPT conversation not yet mounted with verified messages; original session retained, no message sent."));
    try {
      queue.enqueue(input);
      await queue.pulse();
      now += 31 * 60_000;
      await queue.pulse();
      expect(queue.status(id)).toMatchObject({ status: "queued", attempts: 2 });
    } finally {
      queue.close();
      clock.mockRestore();
    }
  });

  it("does not let an unavailable recipient block another conversation or concurrent pulses double-dispatch", async () => {
    let resolveSlow!: (response: DesktopAppActivationResponse) => void;
    const calls: Request[] = [];
    const queue = new ChatGPTDeliveryQueue(makeDir(), async (request) => {
      if (request.type !== "chatgpt.sessions") throw Error("wrong route");
      calls.push(request);
      if (request.expectedConversationId === conversationId)
        return new Promise<DesktopAppActivationResponse>((resolve) => {
          resolveSlow = resolve;
        });
      return observed(request, anotherConversation);
    });
    queue.enqueue(input);
    const first = queue.pulse();
    queue.enqueue({
      ...input,
      messageId: anotherConversation,
      conversationId: anotherConversation,
    });
    await queue.pulse();
    expect(queue.status(anotherConversation).status).toBe("delivered");
    expect(calls.filter((r) => r.expectedConversationId === conversationId)).toHaveLength(1);
    resolveSlow(observed(calls[0]!));
    await first;
    queue.close();
  });
});
