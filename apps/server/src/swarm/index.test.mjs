import { test } from "node:test";
import assert from "node:assert/strict";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { runSwarm } from "./index.mjs";
import { swarmForNativeThread } from "./nativeAgent.mjs";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const D = "00000000-0000-4000-8000-000000000004";
const make = async (fn) => {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3-swarm-review-"));
  const call = (payload, extra = {}) => runSwarm(payload, { root, enabled: true, ...extra });
  try {
    await call({ action: "create", id: A, name: "Review" });
    await fn(call, root);
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

test("native Swarm calls bind the author to the authenticated thread", async () =>
  make(async (call, root) => {
    await call({
      action: "attach",
      swarmId: A,
      kind: "native",
      member: "native",
      threadId: B,
      environmentId: D,
    });
    await call({
      action: "attach",
      swarmId: A,
      kind: "chatgpt",
      member: "browser",
      sessionId: C,
      conversationId: D,
    });
    const sends = [];
    const context = {
      root,
      threadId: B,
      environmentId: D,
      transports: {
        native: async () => {
          throw new Error("unexpected native wake");
        },
        chatgpt: async (request) => {
          sends.push(request);
          return {
            messageId: request.messageId,
            sessionId: request.sessionId,
            conversationId: request.expectedConversationId,
            status: "queued",
          };
        },
      },
    };
    const posted = await swarmForNativeThread(
      {
        action: "post",
        swarmId: A,
        messageId: C,
        body: "Please review @browser",
      },
      context,
    );
    assert.equal(posted.actor, "native");
    assert.equal(posted.data.wakes[0].state, "queued");
    assert.equal(sends.length, 1);
    const read = await swarmForNativeThread({ action: "read", swarmId: A }, context);
    assert.equal(read.actor, "native");
    assert.equal(read.data.messages[0].author, "native");
    await assert.rejects(
      () =>
        swarmForNativeThread(
          { action: "post", swarmId: A, messageId: D, body: "impersonated" },
          { ...context, threadId: C },
        ),
      /exactly one Swarm membership/,
    );
    await assert.rejects(
      () =>
        swarmForNativeThread(
          { action: "read", swarmId: A },
          { ...context, environmentId: "another-environment" },
        ),
      /exactly one Swarm membership/,
    );
  }));

test("authorized coordinator plans, reuses and delegates a mixed team with a durable worker cap", async () =>
  make(async (call) => {
    await call({
      action: "attach",
      swarmId: A,
      kind: "native",
      member: "lead",
      threadId: B,
      environmentId: "env-a",
    });
    await call({
      action: "attach",
      swarmId: A,
      kind: "native",
      member: "existing",
      threadId: C,
      environmentId: "env-a",
    });
    const transportCalls = [];
    const transports = {
      native: async (request) => {
        transportCalls.push(request);
        return {
          threadId: request.threadId,
          messageId: request.clientRequestId,
          messageSent: true,
        };
      },
      chatgpt: async (request) => ({
        messageId: request.messageId,
        sessionId: request.sessionId,
        conversationId: request.expectedConversationId,
        status: "queued",
      }),
    };
    const goal = await call(
      {
        action: "goal",
        swarmId: A,
        goalId: D,
        coordinatorMember: "lead",
        maxConcurrentWorkers: 2,
        goal: "Implement a gameplay feature and document its architecture.",
      },
      { transports },
    );
    assert.equal(goal.wakes[0].state, "accepted");
    const assignments = [
      {
        assignmentId: "00000000-0000-4000-8000-000000000011",
        member: "existing",
        kind: "native",
        title: "Architecture",
        task: "Inspect existing systems and record architecture constraints.",
      },
      {
        assignmentId: "00000000-0000-4000-8000-000000000012",
        member: "browser",
        kind: "chatgpt",
        title: "Implementation",
        task: "Implement the independently scoped gameplay module.",
      },
      {
        assignmentId: "00000000-0000-4000-8000-000000000013",
        member: "later",
        kind: "native",
        title: "Examples",
        task: "Create supporting use case examples.",
      },
    ];
    const coordinatorCaller = { threadId: B, environmentId: "env-a" };
    await assert.rejects(
      () =>
        call(
          { action: "plan", swarmId: A, goalId: D, assignments },
          { coordinatorCaller: { threadId: C, environmentId: "env-a" } },
        ),
      /authenticated native coordinator/i,
    );
    await call({ action: "plan", swarmId: A, goalId: D, assignments }, { coordinatorCaller });
    const launches = [];
    const delegate = async (request) => {
      launches.push(request);
      assert.equal(request.target.providerInstanceId, "chatgpt");
      return {
        taskId: "chatgpt-task:test",
        chatgptSessionId: "00000000-0000-4000-8000-000000000014",
        link: "https://chatgpt.com/c/00000000-0000-4000-8000-000000000015",
        status: "running",
        childThreadId: null,
      };
    };
    const opts = { coordinatorCaller, transports, delegate };
    const first = await call({ action: "dispatch", swarmId: A, goalId: D }, opts);
    assert.deepEqual(
      first.assignments.map((entry) => entry.status),
      ["assigned", "delegated", "capacity_waiting"],
    );
    const second = await call({ action: "dispatch", swarmId: A, goalId: D }, opts);
    assert.equal(launches.length, 1);
    assert.equal(transportCalls.length, 2);
    assert.equal(second.assignments[2].status, "capacity_waiting");
    const board = await call({ action: "read", swarmId: A });
    assert.equal(board.assignments.length, 2);
    assert.ok(
      board.members.some((member) => member.alias === "browser" && member.kind === "chatgpt"),
    );
    assert.deepEqual(
      board.plans[0].assignments.map((entry) => entry.member),
      ["existing", "browser", "later"],
    );
    await assert.rejects(
      () =>
        call({
          action: "goal",
          swarmId: A,
          goalId: "00000000-0000-4000-8000-000000000016",
          coordinatorMember: "lead",
          maxConcurrentWorkers: 2,
          goal: "Another goal",
        }),
      /already has a goal/i,
    );
  }));

test("unknown delegated spawn is never repeated and retains its slot across calls", async () =>
  make(async (call) => {
    await call({ action: "attach", swarmId: A, kind: "native", member: "lead", threadId: B });
    const coordinatorCaller = { threadId: B, environmentId: "env-a" };
    await call({
      action: "goal",
      swarmId: A,
      goalId: D,
      coordinatorMember: "lead",
      maxConcurrentWorkers: 2,
      goal: "Review and implement a feature.",
    });
    await call(
      {
        action: "plan",
        swarmId: A,
        goalId: D,
        assignments: [
          {
            assignmentId: "00000000-0000-4000-8000-000000000021",
            member: "implementer",
            kind: "native",
            title: "Implementation",
            task: "Write the feature.",
          },
          {
            assignmentId: "00000000-0000-4000-8000-000000000022",
            member: "writer",
            kind: "chatgpt",
            title: "Documentation",
            task: "Document the feature.",
          },
        ],
      },
      { coordinatorCaller },
    );
    let count = 0;
    const delegate = async () => {
      count += 1;
      throw new Error("Unknown desktop result");
    };
    const input = { action: "dispatch", swarmId: A, goalId: D };
    await call(input, { coordinatorCaller, delegate });
    await call(input, { coordinatorCaller, delegate });
    assert.equal(count, 2);
    const board = await call({ action: "read", swarmId: A });
    assert.deepEqual(
      board.assignments.map((entry) => entry.status),
      ["uncertain", "uncertain"],
    );
    await assert.rejects(
      () => call({ action: "plan", swarmId: A, goalId: D, assignments: [] }, { coordinatorCaller }),
      /2..24/,
    );
  }));

test("new native and ChatGPT delegations bind through their existing T3 task receipts", async () =>
  make(async (call) => {
    await call({ action: "attach", swarmId: A, kind: "native", member: "lead", threadId: B });
    const coordinatorCaller = { threadId: B, environmentId: "env-a" };
    await call({
      action: "goal",
      swarmId: A,
      goalId: D,
      coordinatorMember: "lead",
      maxConcurrentWorkers: 2,
      goal: "Deliver implementation and documentation.",
    });
    await call(
      {
        action: "plan",
        swarmId: A,
        goalId: D,
        assignments: [
          {
            assignmentId: "00000000-0000-4000-8000-000000000031",
            member: "native_worker",
            kind: "native",
            title: "Core",
            task: "Implement core domain behavior.",
          },
          {
            assignmentId: "00000000-0000-4000-8000-000000000032",
            member: "browser_worker",
            kind: "chatgpt",
            title: "Documentation",
            task: "Write independent API documentation.",
          },
        ],
      },
      { coordinatorCaller },
    );
    const delegate = async (request) =>
      request.target?.providerInstanceId === "chatgpt"
        ? {
            taskId: "chatgpt-task:example",
            status: "running",
            childThreadId: null,
            chatgptSessionId: "00000000-0000-4000-8000-000000000041",
          }
        : {
            taskId: "native-task:example",
            status: "running",
            childThreadId: "00000000-0000-4000-8000-000000000042",
          };
    const initial = await call(
      { action: "dispatch", swarmId: A, goalId: D },
      { coordinatorCaller, delegate },
    );
    assert.deepEqual(
      initial.assignments.map((item) => item.status),
      ["delegated", "delegated"],
    );
    let board = await call({ action: "read", swarmId: A });
    assert.ok(
      board.members.some(
        (member) => member.alias === "native_worker" && member.threadId.endsWith("42"),
      ),
    );
    assert.ok(!board.members.some((member) => member.alias === "browser_worker"));
    const synced = await call(
      { action: "sync", swarmId: A, goalId: D },
      {
        coordinatorCaller,
        taskStatus: async () => ({
          taskId: "chatgpt-task:example",
          status: "running",
          childThreadId: null,
          chatgptSessionId: "00000000-0000-4000-8000-000000000041",
          link: "https://chatgpt.com/c/00000000-0000-4000-8000-000000000043",
        }),
      },
    );
    assert.equal(synced.bindings.length, 1);
    board = await call({ action: "read", swarmId: A });
    assert.ok(
      board.members.some(
        (member) =>
          member.alias === "browser_worker" &&
          member.conversationId === "00000000-0000-4000-8000-000000000043",
      ),
    );
  }));
