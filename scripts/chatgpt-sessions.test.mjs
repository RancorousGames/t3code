import { test } from "node:test";
import assert from "node:assert/strict";
import { controlSessions } from "./chatgpt-sessions.mjs";

const calls = [];
const exchange = async (address, request) => {
  calls.push({ address, request });
  return { version: 1, requestId: request.requestId, ok: true, data: { sessions: [], total: 0 } };
};
const options = { exchange, home: ".t3" };

test("list sends a correlated request on the existing local named pipe", async () => {
  const response = await controlSessions({ action: "list" }, options);
  assert.equal(response.total, 0);
  const call = calls.at(-1);
  assert.equal(call.request.version, 1);
  assert.equal(call.request.type, "chatgpt.sessions");
  assert.equal(call.request.action, "list");
  assert.equal(call.request.which, "visible");
  assert.match(call.address, /^\\\\\.\\pipe\\t3code-app-/);
});

test("list forwards all supported UI filters through the desktop socket", async () => {
  for (const which of ["visible", "recent", "working", "blocked", "all"]) {
    await controlSessions({ action: "list", which }, options);
    assert.equal(calls.at(-1).request.which, which);
  }
});

test("read forwards session selection and first/last count", async () => {
  await controlSessions({ action: "read", sessionId: "id-123", from: "start", count: 1 }, options);
  assert.equal(calls.at(-1).request.sessionId, "id-123");
  assert.equal(calls.at(-1).request.from, "start");
  assert.equal(calls.at(-1).request.count, 1);
});

test("send forwards a message without writing it to command-line arguments", async () => {
  await controlSessions(
    { action: "send", sessionId: "id-123", message: "Continue implementing." },
    options,
  );
  assert.equal(calls.at(-1).request.message, "Continue implementing.");
});

test("rejects invalid operations before contacting the running app", async () => {
  const count = calls.length;
  await assert.rejects(controlSessions({ action: "read" }, options), /sessionId is required/);
  await assert.rejects(
    controlSessions({ action: "send", sessionId: "id" }, options),
    /message required/,
  );
  await assert.rejects(controlSessions({ action: "unknown" }, options), /action must be/);
  await assert.rejects(
    controlSessions({ action: "list", which: "banana" }, options),
    /which applies only/,
  );
  await assert.rejects(
    controlSessions({ action: "read", which: "recent", sessionId: "id" }, options),
    /which applies only/,
  );
  assert.equal(calls.length, count);
});

test("does not report success for older T3 versions without this response", async () => {
  await assert.rejects(
    controlSessions(
      { action: "list" },
      {
        ...options,
        exchange: async () => ({ ok: true, messageSent: true }),
      },
    ),
    /Rebuild and restart/,
  );
});

test("returns T3 failures unchanged", async () => {
  await assert.rejects(
    controlSessions(
      { action: "reload", sessionId: "id" },
      {
        ...options,
        exchange: async () => ({
          ok: false,
          code: "internal-error",
          message: "Actively generating",
        }),
      },
    ),
    /Actively generating/,
  );
});
