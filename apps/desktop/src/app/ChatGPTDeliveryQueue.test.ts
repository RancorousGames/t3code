// @effect-diagnostics globalDate:off nodeBuiltinImport:off -- Temporary filesystem fixtures for the durable outbox.
// Core guarantees of the at-least-once outbox: unobserved sends are resent,
// refusals retry without counting a send, and every message terminates.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "@t3tools/contracts";
import { ChatGPTDeliveryQueue } from "./ChatGPTDeliveryQueue.ts";

type Request = Extract<DesktopAppActivationRequest, { type: "chatgpt.sessions" }>;
const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const id2 = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const conversationId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const input = { messageId: id, sessionId: "browser-B", conversationId, body: "Next game turn" };
const NOW = 1_800_000_000_000;
const dirs: string[] = [];
const makeDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-delivery-"));
  dirs.push(dir);
  return dir;
};
const observed = (request: DesktopAppActivationRequest): DesktopAppActivationResponse => ({
  version: 1, requestId: request.requestId, ok: true,
  data: { messageSent: true, delivery: "user_turn_observed", conversationGuardValidated: true,
    verifiedConversationId: conversationId },
});
const unknown = (request: DesktopAppActivationRequest): DesktopAppActivationResponse => ({
  version: 1, requestId: request.requestId, ok: true,
  data: { messageSent: false, delivery: "unknown", sendAttempted: true },
});
const failure = (request: DesktopAppActivationRequest, message: string): DesktopAppActivationResponse => ({
  version: 1, requestId: request.requestId, ok: false, code: "chatgpt-send-failed", message,
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

/** Queue whose transport answers with `reply`; the clock is driven by `at`. */
function harness(reply: (request: Request, n: number) => DesktopAppActivationResponse) {
  let now = NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const sends: Request[] = [];
  const exhausted: string[] = [];
  const queue = new ChatGPTDeliveryQueue(makeDir(), async (request) => {
    if (request.type !== "chatgpt.sessions") throw Error("wrong request");
    sends.push(request);
    return reply(request, sends.length);
  }, (record) => exhausted.push(record.messageId));
  queue.start();
  return { queue, sends, exhausted, at: (ms: number) => { now = NOW + ms; } };
}

describe("at-least-once ChatGPT delivery queue", () => {
  it("delivers on first observation and marks the message", async () => {
    const h = harness(observed);
    try {
      h.queue.enqueue(input);
      await h.queue.pulse();
      expect(h.queue.status(id).status).toBe("delivered");
      expect(h.sends[0]!.message).toBe(`[T3-MSG:${id}]\nNext game turn`);
    } finally { h.queue.close(); }
  });

  it("resends an unobserved send after backoff until it is observed", async () => {
    const h = harness((request, n) => (n < 3 ? unknown(request) : observed(request)));
    try {
      h.queue.enqueue(input);
      await h.queue.pulse();
      expect(h.queue.status(id).status).toBe("uncertain");
      await h.queue.pulse();
      expect(h.sends).toHaveLength(1); // backoff not elapsed
      h.at(61_000);
      await h.queue.pulse();
      expect(h.sends).toHaveLength(2);
      h.at(61_000 + 121_000);
      await h.queue.pulse();
      expect(h.queue.status(id).status).toBe("delivered");
      expect(h.sends.every((s) => s.message.startsWith(`[T3-MSG:${id}]`))).toBe(true);
    } finally { h.queue.close(); }
  });

  it("retries refusals quickly without counting a send", async () => {
    const h = harness((request, n) =>
      n === 1 ? failure(request, "Composer contains an existing draft; refusing to overwrite it.") : observed(request));
    try {
      h.queue.enqueue(input);
      await h.queue.pulse();
      expect(h.queue.status(id)).toMatchObject({ status: "queued", duplicateResends: 0 });
      h.at(16_000);
      await h.queue.pulse();
      expect(h.queue.status(id).status).toBe("delivered");
    } finally { h.queue.close(); }
  });

  it("gives up an hour after becoming head, notifies once, and frees the lane", async () => {
    const h = harness((request) => (request.message.includes(id2) ? observed(request) : unknown(request)));
    try {
      h.queue.enqueue(input);
      h.queue.enqueue({ ...input, messageId: id2, body: "Second" });
      await h.queue.pulse();
      expect(h.queue.status(id2).status).toBe("queued"); // FIFO behind the head
      h.at(60 * 60_000);
      await h.queue.pulse();
      expect(h.queue.status(id).status).toBe("needs_attention");
      expect(h.exhausted).toEqual([id]);
      expect(h.queue.status(id2).status).toBe("delivered"); // gets its own full turn
    } finally { h.queue.close(); }
  });

  it("recovers a send interrupted by a crash as uncertain", () => {
    const dir = makeDir();
    NodeFS.writeFileSync(NodePath.join(dir, "chatgpt-deliveries-v1.json"), JSON.stringify([{
      ...input, status: "sending", attempts: 1, createdAt: NOW, updatedAt: NOW,
    }]));
    const queue = new ChatGPTDeliveryQueue(dir, async (request) => observed(request));
    expect(queue.status(id).status).toBe("uncertain");
    queue.close();
  });
});
