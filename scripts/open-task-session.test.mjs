import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { openTaskSession } from "./open-task-session.mjs";

const homes = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => FSP.rm(home, { recursive: true, force: true })));
});
async function context() {
  const home = await FSP.mkdtemp(Path.join(OS.tmpdir(), "t3-task-open-"));
  homes.push(home);
  const board = Path.join(home, "board");
  const task = {
    id: "T3-9000",
    title: "Live discussion",
    description: "Review the prototype",
    claimed_by: null,
    live: { with_me: true, brief: "Two layouts ready" },
  };
  const actions = [];
  const command = async (_board, args) => {
    actions.push(args);
    if (args[1] === "show") return { task: { ...task } };
    if (args[1] === "claim") task.claimed_by = args[3];
    return { task: { ...task } };
  };
  return {
    home,
    board,
    task,
    actions,
    command,
    input: { action: "open-task", taskRef: { board, id: task.id } },
  };
}

test("opens a hidden claimed session instead of spawning a second", async () => {
  const ctx = await context();
  ctx.task.claimed_by = "t3-browser:abc";
  let spawnCalls = 0;
  const control = async (request) =>
    request.action === "list"
      ? { sessions: [{ id: "abc", hidden: true }] }
      : { action: "focus", sessionId: "abc" };
  const result = await openTaskSession(ctx.input, {
    home: ctx.home,
    command: ctx.command,
    control,
    exchange: async () => {
      spawnCalls++;
      throw Error("Unexpected spawn");
    },
  });
  assert.equal(result.status, "opened");
  assert.equal(result.sessionId, "abc");
  assert.equal(spawnCalls, 0);
  assert.ok(ctx.actions.some((a) => a.join(" ") === "task live start T3-9000"));
});

test("stable t3: public ChatGPT claim focuses the held session, never a native thread", async () => {
  const ctx = await context();
  ctx.task.claimed_by = "t3:public-id";
  const calls = [];
  const result = await openTaskSession(ctx.input, {
    home: ctx.home,
    command: ctx.command,
    control: async (request) => {
      calls.push(request);
      return request.action === "list"
        ? { sessions: [{ id: "browser-id", browserSessionId: "browser-id", publicSessionId: "public-id", hidden: true }] }
        : { sessionId: "browser-id" };
    },
    native: async () => { throw Error("Native registry must not be called"); },
    exchange: async () => { throw Error("No new ChatGPT guest"); },
  });
  assert.equal(result.kind, "chatgpt");
  assert.equal(result.sessionId, "browser-id");
  assert.deepEqual(calls.map((call) => call.action), ["list", "focus"]);
});

test("t3: native thread claim resolves after ChatGPT registry has no match", async () => {
  const ctx = await context();
  ctx.task.claimed_by = "t3:native-id";
  const result = await openTaskSession(ctx.input, {
    home: ctx.home,
    command: ctx.command,
    control: async () => ({ sessions: [] }),
    native: async (request) => request.action === "list"
      ? { threads: [{ id: "native-id" }] }
      : { threadId: "native-id" },
  });
  assert.equal(result.kind, "native");
  assert.equal(result.threadId, "native-id");
});

test("unclaimed task creates once, claims exact session, then reopens", async () => {
  const ctx = await context();
  let spawnCalls = 0;
  const control = async (request) =>
    request.action === "list"
      ? { sessions: [{ id: "session-1" }] }
      : { action: "focus", sessionId: request.sessionId };
  const exchange = async (_address, request) => {
    spawnCalls++;
    assert.equal(request.type, "chatgpt.spawn");
    assert.match(request.prompt, /Two layouts ready/);
    return { ok: true, messageSent: true, sessionId: "session-1" };
  };
  const options = { home: ctx.home, command: ctx.command, control, exchange };
  const created = await openTaskSession(ctx.input, options);
  const reopened = await openTaskSession(ctx.input, options);
  assert.equal(created.status, "created");
  assert.equal(reopened.status, "opened");
  assert.equal(spawnCalls, 1);
  assert.equal(ctx.task.claimed_by, "t3:session-1");
});

test("unknown spawn stays durable and is not resubmitted", async () => {
  const ctx = await context();
  let spawnCalls = 0;
  const exchange = async (_address, request) => {
    if (request.type === "chatgpt.spawn") {
      spawnCalls++;
      throw Error("timeout");
    }
    return { ok: true, data: { sessions: [] } };
  };
  const options = {
    home: ctx.home,
    command: ctx.command,
    control: async () => ({ sessions: [] }),
    exchange,
  };
  const first = await openTaskSession(ctx.input, options);
  const second = await openTaskSession(ctx.input, options);
  assert.equal(first.status, "unknown");
  assert.equal(second.status, "unknown");
  assert.equal(first.requestId, second.requestId);
  assert.equal(spawnCalls, 1);
});

test("implementation Spawn sends a task-bound worker prompt without a parent", async () => {
  const ctx = await context();
  ctx.input.intent = "implement";
  ctx.task.acceptance_criteria = ["Working implementation", "Commit changes"];
  const requests = [];
  const exchange = async (_address, request) => {
    requests.push(request);
    assert.equal(request.type, "chatgpt.spawn");
    assert.equal(request.role, "worker");
    assert.deepEqual(request.taskRef, { board: ctx.board, id: ctx.task.id });
    assert.match(request.prompt, /Implement TaskBoard task T3-9000/);
    assert.match(request.prompt, /Acceptance criteria:/);
    assert.match(request.prompt, /no child agents/);
    assert.doesNotMatch(request.prompt, /asking your first question/);
    return { ok: true, messageSent: true, sessionId: "worker-1" };
  };
  const result = await openTaskSession(ctx.input, {
    home: ctx.home,
    command: ctx.command,
    exchange,
    control: async ({ sessionId }) => ({ sessionId }),
  });
  assert.equal(result.status, "created");
  assert.equal(ctx.task.claimed_by, "t3:worker-1");
  assert.equal(requests.length, 1);
});
