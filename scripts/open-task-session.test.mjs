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
    kind: "task",
    column: "ai-ready",
    archived: false,
    completed: null,
    attention: [],
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

test("reuses a hidden claimed session without focusing it or spawning another", async () => {
  const ctx = await context();
  ctx.task.claimed_by = "t3-browser:abc";
  let spawnCalls = 0;
  const calls = [];
  const control = async (request) => {
    calls.push(request.action);
    if (request.action === "list") return { sessions: [{ id: "abc", hidden: true }] };
    throw Error("A TaskBoard pickup must never request focus");
  };
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
  assert.deepEqual(calls, ["list"]);
  assert.ok(ctx.actions.some((a) => a.join(" ") === "task live start T3-9000"));
});

test("legacy bare UUID claim uses the same open-task path and does not spawn", async () => {
  const ctx = await context();
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  ctx.task.claimed_by = sessionId;
  const calls = [];
  const result = await openTaskSession(ctx.input, {
    home: ctx.home,
    command: ctx.command,
    control: async (request) => {
      calls.push(request.action);
      return request.action === "list"
        ? { sessions: [{ id: sessionId, hidden: true }] }
        : { sessionId };
    },
    exchange: async () => {
      throw Error("Existing claim must never spawn");
    },
  });
  assert.equal(result.sessionId, sessionId);
  assert.deepEqual(calls, ["list"]);
  assert.ok(ctx.actions.some((args) => args.join(" ") === "task live start T3-9000"));
});

test("stable t3: public ChatGPT claim reuses the held session without changing selection", async () => {
  const ctx = await context();
  ctx.task.claimed_by = "t3:public-id";
  const calls = [];
  const result = await openTaskSession(ctx.input, {
    home: ctx.home,
    command: ctx.command,
    control: async (request) => {
      calls.push(request);
      return request.action === "list"
        ? {
            sessions: [
              {
                id: "browser-id",
                browserSessionId: "browser-id",
                publicSessionId: "public-id",
                hidden: true,
              },
            ],
          }
        : { sessionId: "browser-id" };
    },
    native: async () => {
      throw Error("Native registry must not be called");
    },
    exchange: async () => {
      throw Error("No new ChatGPT guest");
    },
  });
  assert.equal(result.kind, "chatgpt");
  assert.equal(result.sessionId, "browser-id");
  assert.deepEqual(
    calls.map((call) => call.action),
    ["list"],
  );
});

test("a background pickup reuses the claimed native thread without changing selection", async () => {
  const ctx = await context();
  ctx.task.claimed_by = "t3:native-id";
  const nativeActions = [];
  const result = await openTaskSession(
    { ...ctx.input, background: true },
    {
      home: ctx.home,
      command: ctx.command,
      control: async () => ({ sessions: [] }),
      native: async (request) => {
        nativeActions.push(request.action);
        return request.action === "list"
          ? { threads: [{ id: "native-id" }] }
          : { threadId: "native-id" };
      },
    },
  );
  assert.equal(result.kind, "native");
  assert.equal(result.threadId, "native-id");
  assert.deepEqual(nativeActions, ["list"]);
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
    assert.equal(request.autoClose, undefined); // Conversation-only spawns remain opt-in.
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

test("manual task retries only after exact prior blank guest is verifiably closed", async () => {
  const ctx = await context();
  let calls = 0;
  let oldRequestId;
  const input = { ...ctx.input, background: true };
  const options = {
    home: ctx.home,
    command: ctx.command,
    control: async () => ({
      sessions: [
        {
          id: "closed-blank",
          spawnRequestId: oldRequestId,
          closedAt: "2026-11-14T00:20:00Z",
          conversationId: null,
          bootstrapIdentity: { state: "awaiting_marker" },
          binding: { taskRef: { board: ctx.board, id: ctx.task.id } },
          lastRole: null,
          totalTurns: 0,
        },
      ],
    }),
    exchange: async (_address, request) => {
      calls++;
      if (calls === 1) {
        oldRequestId = request.requestId;
        return {
          ok: true,
          data: {
            action: "spawn",
            created: true,
            sessionId: "closed-blank",
            promptDelivery: "unknown",
            messageSent: false,
          },
        };
      }
      return { ok: true, messageSent: true, sessionId: "replacement" };
    },
  };
  const first = await openTaskSession(input, options);
  assert.equal(first.status, "prompt_unknown");
  assert.equal(ctx.task.claimed_by, null);
  const second = await openTaskSession(input, options);
  assert.equal(second.status, "created");
  assert.equal(ctx.task.claimed_by, "t3:replacement");
  assert.equal(calls, 2);
  const retired = (await FSP.readdir(Path.join(ctx.home, "userdata", "task-open-locks"))).filter(
    (name) => name.endsWith(`.retired-${oldRequestId}`),
  );
  assert.equal(retired.length, 1);
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
    assert.equal(request.autoClose, true); // TaskBoard Start now
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

test("T3 queue pickup binds the TaskBoard reservation and atomically marks the session working", async () => {
  const ctx = await context();
  const queueRequest = "11111111-1111-4111-8111-111111111111";
  const reservationId = "22222222-2222-4222-8222-222222222222";
  const queueIntent = {
    mode: "queue",
    queue_request: queueRequest,
    queue_attempt: null,
    queue_receipt: null,
    queue_retired_receipt: null,
    queue_state: "starting",
    queue_reservation_id: reservationId,
  };
  const queueInput = {
    ...ctx.input,
    intent: "implement",
    kind: "chatgpt",
    background: true,
    requireQueue: true,
    queueRequest,
    reservationId,
  };
  const exchangeCalls = [];
  const command = async (_board, args) => {
    ctx.actions.push(args);
    if (args[1] === "show") return { task: { ...ctx.task }, readiness: "ready" };
    if (args[1] === "execution") return queueIntent;
    if (args[1] === "queue" && args[2] === "working") {
      assert.equal(args[4], "--queue-request");
      assert.equal(args[5], queueRequest);
      assert.equal(args[7], reservationId);
      assert.equal(args[9], "queue-session");
      queueIntent.queue_state = "working";
      queueIntent.queue_session_id = "queue-session";
      ctx.task.claimed_by = "t3:queue-session";
    }
    return { task: { ...ctx.task } };
  };
  const result = await openTaskSession(queueInput, {
    home: ctx.home,
    command,
    exchange: async (_address, request) => {
      exchangeCalls.push(request);
      return { ok: true, messageSent: true, sessionId: "queue-session" };
    },
  });
  assert.equal(result.status, "created");
  assert.equal(exchangeCalls.length, 1);
  assert.equal(exchangeCalls[0].requestId, reservationId);
  assert.equal(exchangeCalls[0].autoClose, true); // T3 queued admission
  assert.equal(queueIntent.queue_state, "working");
  assert.equal(ctx.task.claimed_by, "t3:queue-session");
});

test("a green custom column dispatches through the same guarded TaskBoard queue protocol", async () => {
  const ctx = await context();
  ctx.task.column = "chatgpt-sessions";
  const queueRequest = "12121212-1212-4121-8121-121212121212";
  const reservationId = "34343434-3434-4343-8343-343434343434";
  const queueIntent = {
    mode: "queue",
    queue_request: queueRequest,
    queue_state: "starting",
    queue_reservation_id: reservationId,
  };
  let spawns = 0;
  const command = async (_board, args) => {
    if (args[1] === "show") return { task: { ...ctx.task }, readiness: "ready" };
    if (args[1] === "execution") return queueIntent;
    if (args[1] === "queue" && args[2] === "working") {
      assert.equal(args[7], reservationId);
      queueIntent.queue_state = "working";
      queueIntent.queue_session_id = "custom-column-session";
      ctx.task.claimed_by = "t3:custom-column-session";
    }
    return { task: { ...ctx.task } };
  };
  const result = await openTaskSession(
    {
      ...ctx.input,
      intent: "implement",
      kind: "chatgpt",
      background: true,
      requireQueue: true,
      queueRequest,
      reservationId,
    },
    {
      home: ctx.home,
      command,
      exchange: async () => {
        spawns++;
        return { ok: true, messageSent: true, sessionId: "custom-column-session" };
      },
    },
  );
  assert.equal(result.status, "created");
  assert.equal(spawns, 1);
  assert.equal(queueIntent.queue_state, "working");
  assert.equal(ctx.task.claimed_by, "t3:custom-column-session");
});

test("unknown queue spawn is reconciled with the same reservation and never resubmitted", async () => {
  const ctx = await context();
  const queueRequest = "33333333-3333-4333-8333-333333333333";
  const reservationId = "44444444-4444-4444-8444-444444444444";
  const queueIntent = {
    mode: "queue",
    queue_request: queueRequest,
    queue_attempt: null,
    queue_receipt: null,
    queue_retired_receipt: null,
    queue_state: "starting",
    queue_reservation_id: reservationId,
  };
  const queueInput = {
    ...ctx.input,
    intent: "implement",
    kind: "chatgpt",
    background: true,
    requireQueue: true,
    queueRequest,
    reservationId,
  };
  let spawnCalls = 0;
  let sessionVisible = false;
  const command = async (_board, args) => {
    if (args[1] === "show") return { task: { ...ctx.task }, readiness: "ready" };
    if (args[1] === "execution") return queueIntent;
    if (args[1] === "queue" && args[2] === "working") {
      queueIntent.queue_state = "working";
      queueIntent.queue_session_id = "recovered-session";
      ctx.task.claimed_by = "t3:recovered-session";
    }
    return { task: { ...ctx.task } };
  };
  const exchange = async (_address, request) => {
    if (request.type === "chatgpt.spawn") {
      spawnCalls++;
      throw Error("transport timed out");
    }
    return {
      ok: true,
      data: {
        sessions: sessionVisible
          ? [{ id: "recovered-session", spawnRequestId: reservationId }]
          : [],
      },
    };
  };
  const options = { home: ctx.home, command, exchange };
  const first = await openTaskSession(queueInput, options);
  assert.equal(first.status, "unknown");
  sessionVisible = true;
  const second = await openTaskSession(queueInput, options);
  assert.equal(second.status, "prompt_unknown");
  assert.equal(spawnCalls, 1);
  assert.equal(second.sessionId, "recovered-session");
  assert.equal(queueIntent.queue_state, "starting");
  assert.equal(ctx.task.claimed_by, null);
});

test("a definite T3 rejection releases its journal for a new TaskBoard reservation", async () => {
  const ctx = await context();
  const queueRequest = "55555555-5555-4555-8555-555555555555";
  const firstReservation = "66666666-6666-4666-8666-666666666666";
  const secondReservation = "77777777-7777-4777-8777-777777777777";
  const queueIntent = {
    mode: "queue",
    queue_request: queueRequest,
    queue_attempt: null,
    queue_receipt: null,
    queue_retired_receipt: null,
    queue_state: "starting",
    queue_reservation_id: firstReservation,
  };
  const queueInput = {
    ...ctx.input,
    intent: "implement",
    kind: "chatgpt",
    background: true,
    requireQueue: true,
    queueRequest,
    reservationId: firstReservation,
  };
  let spawnCalls = 0;
  const command = async (_board, args) => {
    if (args[1] === "show") return { task: { ...ctx.task }, readiness: "ready" };
    if (args[1] === "execution") return queueIntent;
    if (args[1] === "queue" && args[2] === "working") {
      queueIntent.queue_state = "working";
      queueIntent.queue_session_id = "retry-session";
      ctx.task.claimed_by = "t3:retry-session";
    }
    return { task: { ...ctx.task } };
  };
  const exchange = async () => {
    spawnCalls++;
    return spawnCalls === 1
      ? { ok: false, code: "invalid-request", message: "Rejected before session creation" }
      : { ok: true, messageSent: true, sessionId: "retry-session" };
  };
  const options = { home: ctx.home, command, exchange };
  const rejected = await openTaskSession(queueInput, options);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.definitelyNotCreated, true);
  queueIntent.queue_reservation_id = secondReservation;
  queueIntent.queue_state = "starting";
  const retried = await openTaskSession(
    { ...queueInput, reservationId: secondReservation },
    options,
  );
  assert.equal(retried.status, "created");
  assert.equal(spawnCalls, 2);
});

test("a changed task after an uncertain spawn keeps its reservation Starting", async () => {
  const ctx = await context();
  const queueRequest = "88888888-8888-4888-8888-888888888888";
  const reservationId = "99999999-9999-4999-8999-999999999999";
  const queueIntent = {
    mode: "queue",
    queue_request: queueRequest,
    queue_attempt: null,
    queue_receipt: null,
    queue_retired_receipt: null,
    queue_state: "starting",
    queue_reservation_id: reservationId,
  };
  const queueInput = {
    ...ctx.input,
    intent: "implement",
    kind: "chatgpt",
    background: true,
    requireQueue: true,
    queueRequest,
    reservationId,
  };
  let spawnCalls = 0;
  const command = async (_board, args) => {
    if (args[1] === "show") return { task: { ...ctx.task }, readiness: "blocked" };
    if (args[1] === "execution") return queueIntent;
    throw new Error("No TaskBoard mutation expected for an unresolved spawn.");
  };
  const exchange = async (_address, request) => {
    if (request.type === "chatgpt.spawn") {
      spawnCalls++;
      throw Error("transport timed out after possible acceptance");
    }
    return { ok: true, data: { sessions: [] } };
  };
  const options = { home: ctx.home, command, exchange };
  // A new reservation has no journal yet, so the not-ready task is safely rejected.
  // Simulate that it became not-ready after T3 entered the spawn request instead.
  ctx.task.column = "blocked";
  const journal = Path.join(ctx.home, "userdata", "task-open-locks");
  const hash = (await import("node:crypto"))
    .createHash("sha256")
    .update(ctx.board.toLowerCase() + "\0" + ctx.task.id)
    .digest("hex");
  await FSP.mkdir(journal, { recursive: true });
  await FSP.writeFile(
    Path.join(journal, hash + ".json"),
    JSON.stringify({
      kind: "chatgpt",
      intent: "implement",
      requestId: reservationId,
    }),
  );
  const result = await openTaskSession(queueInput, options);
  assert.equal(result.status, "unknown");
  assert.equal(result.definitelyNotCreated, undefined);
  assert.equal(spawnCalls, 0);
});

test("a released queue worker's old journal does not block a fresh reservation", async () => {
  const ctx = await context();
  const queueRequest = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const oldReservation = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const newReservation = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const queueIntent = {
    mode: "queue",
    queue_request: queueRequest,
    queue_attempt: null,
    queue_receipt: null,
    queue_retired_receipt: null,
    queue_state: "starting",
    queue_reservation_id: newReservation,
  };
  const queueInput = {
    ...ctx.input,
    intent: "implement",
    kind: "chatgpt",
    background: true,
    requireQueue: true,
    queueRequest,
    reservationId: newReservation,
  };
  const command = async (_board, args) => {
    if (args[1] === "show") return { task: { ...ctx.task }, readiness: "ready" };
    if (args[1] === "execution") return queueIntent;
    if (args[1] === "queue" && args[2] === "working") {
      assert.equal(args[7], newReservation);
      queueIntent.queue_state = "working";
      queueIntent.queue_session_id = "fresh-session";
      ctx.task.claimed_by = "t3:fresh-session";
    }
    return { task: { ...ctx.task } };
  };
  const hash = (await import("node:crypto"))
    .createHash("sha256")
    .update(ctx.board.toLowerCase() + "\0" + ctx.task.id)
    .digest("hex");
  const journalDir = Path.join(ctx.home, "userdata", "task-open-locks");
  await FSP.mkdir(journalDir, { recursive: true });
  await FSP.writeFile(
    Path.join(journalDir, hash + ".json"),
    JSON.stringify({
      kind: "chatgpt",
      intent: "implement",
      requestId: oldReservation,
      taskRef: { board: ctx.board, id: ctx.task.id },
      queueRequest,
    }),
  );
  let spawnCalls = 0;
  const result = await openTaskSession(queueInput, {
    home: ctx.home,
    command,
    exchange: async (_address, request) => {
      if (request.type === "chatgpt.spawn") spawnCalls++;
      assert.equal(request.requestId, newReservation);
      return { ok: true, messageSent: true, sessionId: "fresh-session" };
    },
  });
  assert.equal(result.status, "created");
  assert.equal(spawnCalls, 1);
  assert.equal(queueIntent.queue_state, "working");
  assert.equal(ctx.task.claimed_by, "t3:fresh-session");
});

test("missing claimed guest reuses its indexed conversation and never sends a new prompt", async () => {
  const ctx = await context();
  ctx.task.claimed_by = "t3-browser:lost-session";
  const calls = [];
  const result = await openTaskSession(ctx.input, {
    home: ctx.home,
    command: ctx.command,
    conversationLookup: async (_home, sessionId) => {
      assert.equal(sessionId, "lost-session");
      return "11111111-1111-4111-8111-111111111111";
    },
    control: async (request) => {
      calls.push(request);
      if (request.action === "list") return { sessions: [] };
      if (request.action === "open")
        return {
          sessionId: "recovered",
          conversationId: request.sessionId,
          created: true,
        };
      if (request.action === "focus") return { sessionId: request.sessionId };
      throw Error("Unexpected control request");
    },
    exchange: async () => {
      throw Error("Must not spawn another prompt");
    },
  });
  assert.equal(result.status, "opened");
  assert.equal(result.sessionId, "recovered");
  assert.equal(result.claimRebindRequired, true);
  assert.deepEqual(
    calls.map((call) => call.action),
    ["list", "open"],
  );
});

test("missing claimed session with ambiguous transcript refuses creation", async () => {
  const ctx = await context();
  ctx.task.claimed_by = "t3-browser:lost-session";
  await assert.rejects(
    openTaskSession(ctx.input, {
      home: ctx.home,
      command: ctx.command,
      conversationLookup: async () => null,
      control: async () => ({ sessions: [] }),
      exchange: async () => {
        throw Error("Must not spawn");
      },
    }),
    /no unique saved conversation/,
  );
});

test("native default selects the one matching project and provider without guessing a workspace", async () => {
  const ctx = await context();
  ctx.input.kind = "claude";
  ctx.task.model_selection = { provider: "claudeAgent", model: "claude-sonnet", effort: "medium" };
  const requests = [];
  const threadId = "33333333-3333-4333-8333-333333333333";
  const native = async (request) => {
    requests.push(request);
    if (request.action === "list")
      return {
        environmentId: "environment-1",
        threads: [
          {
            id: "existing",
            projectId: "44444444-4444-4444-8444-444444444444",
            project: Path.basename(Path.dirname(ctx.board)),
            workspaceRoot: "D:\\Projects\\Board",
            providerInstanceId: "claudeAgent",
            modelSelection: { model: "claude-sonnet" },
          },
        ],
      };
    if (request.action === "providers")
      return {
        providers: [
          {
            driver: "claudeAgent",
            providerInstanceId: "claudeAgent",
            installed: true,
            enabled: true,
            status: "ready",
            available: true,
            models: [{ slug: "claude-sonnet", isDefault: true }],
          },
        ],
      };
    if (request.action === "create") return { threadId };
    if (request.action === "focus") return { threadId: request.threadId };
    throw Error("Unexpected native action");
  };
  const result = await openTaskSession(ctx.input, {
    home: ctx.home,
    command: ctx.command,
    native,
    control: async () => ({ liveTaskStartKind: "claude" }),
  });
  assert.equal(result.status, "created");
  assert.equal(ctx.task.claimed_by, "t3:" + threadId);
  assert.equal(
    requests.find((call) => call.action === "create").workspaceRoot,
    "D:\\Projects\\Board",
  );
  assert.equal(
    requests.find((call) => call.action === "create").modelSelection.model,
    "claude-sonnet",
  );
  assert.equal(
    requests.some((call) => call.action === "focus"),
    false,
  );
});

test("native task without a project fails safely when no ready provider exists", async () => {
  const ctx = await context();
  ctx.input.kind = "codex";
  ctx.task.model_selection = { provider: "codex", model: "gpt-6-luna", effort: "medium" };
  await assert.rejects(
    openTaskSession(ctx.input, {
      home: ctx.home,
      command: ctx.command,
      native: async ({ action }) => {
        if (action === "list") return { environmentId: "environment-1", threads: [] };
        if (action === "providers") return { providers: [] };
        throw Error("Must not create without a matching provider");
      },
      control: async () => ({ liveTaskStartKind: "codex" }),
    }),
    /No unique ready native provider/,
  );
});

test("background native creation uses a registered project without stealing selection", async () => {
  const ctx = await context();
  ctx.input.kind = "codex";
  ctx.task.model_selection = { provider: "codex", model: "gpt-default", effort: "medium" };
  ctx.input.background = true;
  const { DatabaseSync } = await import("node:sqlite");
  const dataDir = Path.join(ctx.home, "userdata");
  await FSP.mkdir(dataDir, { recursive: true });
  const database = new DatabaseSync(Path.join(dataDir, "statev2.sqlite"));
  database.exec(
    "CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT, default_model_selection_json TEXT, deleted_at TEXT)",
  );
  database
    .prepare("INSERT INTO projection_projects VALUES (?, ?, ?, ?, NULL)")
    .run(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      Path.basename(Path.dirname(ctx.board)),
      "D:\\Projects\\Board",
      JSON.stringify({ provider: "codex", model: "gpt-default" }),
    );
  database.close();
  const calls = [];
  const result = await openTaskSession(ctx.input, {
    home: ctx.home,
    command: ctx.command,
    control: async () => ({ liveTaskStartKind: "codex" }),
    native: async (request) => {
      calls.push(request);
      if (request.action === "list") return { environmentId: "env-1", threads: [] };
      if (request.action === "providers")
        return {
          providers: [
            {
              providerInstanceId: "codex",
              driver: "codex",
              installed: true,
              enabled: true,
              status: "ready",
              available: true,
              models: [{ slug: "gpt-default", isDefault: true }],
            },
          ],
        };
      if (request.action === "create") return { threadId: request.clientRequestId };
      if (request.action === "focus") return { threadId: request.threadId };
      throw Error("Unexpected action");
    },
  });
  assert.equal(result.status, "created");
  assert.equal(calls.find((call) => call.action === "create").workspaceRoot, "D:\\Projects\\Board");
  assert.equal(calls.find((call) => call.action === "create").modelSelection.model, "gpt-default");
  assert.equal(
    calls.some((call) => call.action === "focus"),
    false,
  );
});

test("queued legacy/ChatGPT task starts a browser worker even with a native default", async () => {
  const ctx = await context();
  const reservationId = "a1111111-1111-4111-8111-111111111111";
  const queueRequest = "b2222222-2222-4222-8222-222222222222";
  let spawned = 0;
  const result = await openTaskSession(
    {
      ...ctx.input,
      intent: "implement",
      requireQueue: true,
      reservationId,
      queueRequest,
      background: true,
    },
    {
      home: ctx.home,
      command: async (_board, args) => {
        if (args[1] === "show") return { task: { ...ctx.task }, readiness: "ready" };
        if (args[1] === "execution")
          return {
            mode: "queue",
            queue_request: queueRequest,
            queue_state: "starting",
            queue_reservation_id: reservationId,
          };
        if (args[1] === "queue" && args[2] === "working") return {};
        return {};
      },
      control: async () => ({ liveTaskStartKind: "codex" }),
      native: async () => {
        throw Error("ChatGPT selection must not spawn native T3");
      },
      exchange: async (_address, request) => {
        spawned++;
        assert.equal(request.type, "chatgpt.spawn");
        return { ok: true, messageSent: true, sessionId: "browser-worker" };
      },
    },
  );
  assert.equal(result.kind, "chatgpt");
  assert.equal(result.status, "created");
  assert.equal(spawned, 1);
});

test("queued GPT-6 Luna Low uses native Codex thread with low effort", async () => {
  const ctx = await context();
  ctx.task.model_selection = { provider: "codex", model: "gpt-6-luna", effort: "low" };
  const reservationId = "c3333333-3333-4333-8333-333333333333";
  const queueRequest = "d4444444-4444-4444-8444-444444444444";
  let nativeCreate;
  let working;
  const result = await openTaskSession(
    {
      ...ctx.input,
      intent: "implement",
      requireQueue: true,
      reservationId,
      queueRequest,
      background: true,
    },
    {
      home: ctx.home,
      command: async (_board, args) => {
        if (args[1] === "show") return { task: { ...ctx.task }, readiness: "ready" };
        if (args[1] === "execution")
          return {
            mode: "queue",
            queue_request: queueRequest,
            queue_state: "starting",
            queue_reservation_id: reservationId,
          };
        if (args[1] === "queue" && args[2] === "working") working = args;
        return {};
      },
      native: async (request) => {
        if (request.action === "list") return { environmentId: "environment-1", threads: [] };
        if (request.action === "providers")
          return {
            providers: [
              {
                providerInstanceId: "codex",
                driver: "codex",
                installed: true,
                enabled: true,
                status: "ready",
                available: true,
                models: [{ slug: "gpt-6-luna", isDefault: false }],
              },
            ],
          };
        if (request.action === "create") {
          nativeCreate = request;
          return { threadId: request.clientRequestId };
        }
        throw Error("Unexpected native operation " + request.action);
      },
      exchange: async () => {
        throw Error("Native selection must not spawn a browser");
      },
    },
  );
  assert.equal(result.kind, "codex");
  assert.equal(result.status, "created");
  assert.equal(nativeCreate.modelSelection.model, "gpt-6-luna");
  assert.deepEqual(nativeCreate.modelSelection.options, [{ id: "reasoningEffort", value: "low" }]);
  assert.equal(nativeCreate.workspaceRoot, Path.dirname(ctx.board));
  assert.equal(working[2], "working");
  assert.ok(working.includes(reservationId));
  assert.ok(working.includes(result.threadId));
});
