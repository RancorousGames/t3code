import { test } from "node:test";
import assert from "node:assert/strict";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { runSwarm } from "./index.mjs";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const D = "00000000-0000-4000-8000-000000000004";
const make = async (fn) => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-swarm-review-"));
  const call = (payload, extra = {}) => runSwarm(payload, { root, enabled: true, ...extra });
  try {
    await call({ action: "create", id: A, name: "Review" });
    await fn(call);
  } finally {
    await FS.rm(root, { recursive: true, force: true });
  }
};

test("inline mentions notify a native member exactly once on idempotent replay", async () =>
  make(async (call) => {
    await call({ action: "attach", swarmId: A, kind: "native", member: "worker", threadId: B });
    const deliveries = [];
    const transports = {
      native: async (request) => {
        deliveries.push(request);
        return {
          threadId: request.threadId,
          messageId: request.clientRequestId,
          messageSent: true,
        };
      },
      chatgpt: async () => {
        throw new Error("unexpected ChatGPT send");
      },
    };
    const post = {
      action: "post",
      swarmId: A,
      messageId: C,
      author: "human",
      body: "Please check this, @worker, then reply here.",
    };
    const first = await call(post, { transports });
    assert.deepEqual(first.message.mentions, ["worker"]);
    assert.equal(first.wakes[0].state, "accepted");
    const second = await call(post, { transports });
    assert.equal(second.created, false);
    assert.equal(deliveries.length, 1);
  }));

test("agents can read incremental messages with a stable message cursor", async () =>
  make(async (call) => {
    await call({ action: "post", swarmId: A, messageId: B, author: "human", body: "one" });
    await call({ action: "post", swarmId: A, messageId: C, author: "human", body: "two" });
    await call({ action: "post", swarmId: A, messageId: D, author: "human", body: "three" });
    const page = await call({
      action: "read",
      swarmId: A,
      limit: 2,
      afterMessageId: B,
      includeWakes: false,
    });
    assert.deepEqual(
      page.messages.map((m) => m.body),
      ["two", "three"],
    );
    assert.equal(page.nextAfterMessageId, D);
    assert.equal(page.hasMore, false);
    assert.deepEqual(page.wakes, []);
    await assert.rejects(
      () =>
        call({
          action: "read",
          swarmId: A,
          afterMessageId: "00000000-0000-4000-8000-000000009999",
        }),
      /cursor|not found/i,
    );
  }));

test("removed members can reattach; historical delivery stays bound to its original recipient", async () =>
  make(async (call) => {
    await call({
      action: "attach",
      swarmId: A,
      kind: "chatgpt",
      member: "browser",
      sessionId: B,
      conversationId: C,
    });
    const deliveries = [];
    const transports = {
      native: async () => {
        throw new Error("should not send native");
      },
      chatgpt: async (request) => {
        deliveries.push(request);
        if (request.action === "delivery_status")
          return { status: "delivered", messageId: request.messageId };
        return {
          sessionId: request.sessionId,
          conversationId: request.expectedConversationId,
          messageId: request.messageId,
          status: "queued",
        };
      },
    };
    await call(
      {
        action: "post",
        swarmId: A,
        messageId: D,
        author: "human",
        body: "Original @browser notification",
      },
      { transports },
    );
    const removed = await call({ action: "detach", swarmId: A, member: "browser" });
    assert.equal(removed.detached, true);
    // Replaying an acknowledged board post must not fail or redirect an old
    // mention just because the recipient has since left the swarm.
    const replay = await call(
      {
        action: "post",
        swarmId: A,
        messageId: D,
        author: "human",
        body: "Original @browser notification",
      },
      { transports },
    );
    assert.equal(replay.created, false);
    await call({ action: "attach", swarmId: A, kind: "native", member: "browser", threadId: B });
    const result = await call({ action: "delivery", swarmId: A }, { transports });
    assert.equal(result.wakes[0].recipient.conversationId, C);
    assert.equal(result.wakes[0].liveReceipt.status, "delivered");
    assert.equal(deliveries.filter((d) => d.action === "enqueue").length, 1);
    await assert.rejects(
      () =>
        call({
          action: "post",
          swarmId: A,
          author: "browser",
          body: "wrong identity",
          messageId: D,
        }),
      /conflict|different content/i,
    );
  }));

test("a missing delivery bridge leaves an intent pending for later explicit wake", async () =>
  make(async (call) => {
    await call({ action: "attach", swarmId: A, kind: "native", member: "worker", threadId: B });
    const request = {
      action: "post",
      swarmId: A,
      messageId: C,
      author: "human",
      body: "Please help @worker",
    };
    const blocked = await call(request);
    assert.equal(blocked.wakes[0].state, "pending");
    const deliveries = [];
    const transports = {
      native: async (message) => {
        deliveries.push(message);
        return {
          threadId: message.threadId,
          messageId: message.clientRequestId,
          messageSent: true,
        };
      },
      chatgpt: async () => {
        throw new Error("unused");
      },
    };
    const resumed = await call(
      { action: "wake", swarmId: A, messageId: C, member: "worker" },
      { transports },
    );
    assert.equal(resumed.wake.state, "accepted");
    assert.equal(deliveries.length, 1);
  }));
