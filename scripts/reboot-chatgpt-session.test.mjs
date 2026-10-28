import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { parseRebootArgs, parseRebootJsonInput, rebootExistingT3Session } from "./reboot-chatgpt-session.mjs";

test("generic T3 Agent Reboot requires no OpenRig seat, role, or ChatGPT UUID from OpenRig", async () => {
  const id = randomUUID();
  const args = parseRebootArgs(["--session-id", id, "--message", "Continue this chat."]);
  const seen = [];
  const result = await rebootExistingT3Session(args, { exchange: async (_address, request) => {
    seen.push(request);
    return { requestId: request.requestId, version: 1, ok: true,
      data: { action: "reboot", sessionId: id, rebootGeneration: 2, status: "submitted" } };
  } });
  assert.equal(result.sessionId, id);
  assert.equal(result.rebootGeneration, 2);
  assert.equal(result.status, "submitted");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "chatgpt.reboot");
  assert.equal(seen[0].priorConversationId, undefined);
  assert.equal(seen[0].seatId, undefined);
  assert.equal(seen[0].phase, "begin");
});

test("self conversation URL resolves exactly one existing hidden or visible T3 session", async () => {
  const conversationId = randomUUID();
  const sessionId = randomUUID();
  const args = parseRebootArgs([
    "--conversation-url", "https://chatgpt.com/c/" + conversationId,
    "--message", "I am the same agent. Continue the assigned work.",
  ]);
  const seen = [];
  const result = await rebootExistingT3Session(args, { exchange: async (_address, request) => {
    seen.push(request);
    return request.type === "chatgpt.sessions" ?
      { version: 1, requestId: request.requestId, ok: true,
        data: { sessions: [
          { id: sessionId, hidden: true, url: "https://chatgpt.com/c/" + conversationId },
          { id: randomUUID(), url: "https://chatgpt.com/c/" + randomUUID() },
        ] } }
      : { version: 1, requestId: request.requestId, ok: true,
          data: { action: "reboot", sessionId, rebootGeneration: 1, status: "unknown" } };
  } });
  assert.equal(result.sessionId, sessionId);
  assert.equal(seen[0].includeHidden, true);
  assert.equal(seen[1].sessionId, sessionId);
});

test("repeated conversation matches never choose an arbitrary browser", async () => {
  const conversationId = randomUUID();
  const args = parseRebootArgs([
    "--conversation-id", conversationId, "--message", "Resume",
  ]);
  const sent = [];
  await assert.rejects(() => rebootExistingT3Session(args, {
    exchange: async (_address, request) => {
      sent.push(request);
      return { requestId: request.requestId, version: 1, ok: true,
        data: { sessions: [
          { id: randomUUID(), conversationId }, { id: randomUUID(), conversationId },
        ] },
      };
    },
  }), /does not map to ONE T3 session/);
  assert.equal(sent.length, 1);
});

test("finalize reuses durable operation UUID without re-sending initial message", async () => {
  const sessionId = randomUUID(), requestId = randomUUID();
  const args = parseRebootArgs([
    "--session-id", sessionId, "--request-id", requestId, "--phase", "finalize",
  ]);
  let count = 0;
  const result = await rebootExistingT3Session(args, {
    exchange: async (_address, request) => {
      count++;
      assert.equal(request.requestId, requestId);
      assert.equal(request.prompt, undefined);
      return { requestId, version: 1, ok: true,
        data: { action: "reboot", sessionId, rebootGeneration: 1, status: "committed" } };
    },
  });
  assert.equal(result.status, "committed");
  assert.equal(count, 1);
});

test("invalid or ambiguous instructions cannot reboot a different session", () => {
  assert.throws(() => parseRebootArgs(["--message", "continue"]), /Specify --session-id/);
  assert.throws(() => parseRebootArgs(["--session-id", randomUUID(), "--phase", "finalize"]),
    /require --request-id/);
  assert.throws(() => parseRebootArgs(["--session-id", randomUUID()]), /continuation summary/);
  assert.throws(() => parseRebootArgs([
    "--session-id", randomUUID(), "--conversation-url", "https://example.com/c/" + randomUUID(),
    "--message", "hello",
  ]), /ChatGPT/);
});

test("older standalone T3 browser session id 'chatgpt' can reboot without OpenRig", async () => {
  const args = parseRebootArgs(["--session-id", "chatgpt", "--message", "Resume the same task."]);
  const result = await rebootExistingT3Session(args, { exchange: async (_address, request) => {
    assert.equal(request.sessionId, "chatgpt");
    assert.equal(request.type, "chatgpt.reboot");
    return { requestId: request.requestId, version: 1, ok: true, data: {
      action: "reboot", sessionId: "chatgpt", rebootGeneration: 1, status: "submitted",
    } };
  } });
  assert.equal(result.sessionId, "chatgpt");
});


test("OMCP JSON-stdin reboot requires an explicit exact identity and handoff", async () => {
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const args = parseRebootJsonInput({
    action: "reboot", sessionId, requestId, message: "Continue the same work.",
  });
  const sent = [];
  const result = await rebootExistingT3Session(args, { exchange: async (_address, request) => {
    sent.push(request);
    return { requestId, version: 1, ok: true,
      data: { action: "reboot", sessionId, rebootGeneration: 2, status: "submitted" } };
  } });
  assert.equal(result.requestId, requestId);
  assert.equal(sent[0].type, "chatgpt.reboot");
  assert.equal(sent[0].prompt, "Continue the same work.");
  assert.equal(sent.length, 1);

  const status = parseRebootJsonInput({
    action: "reboot", sessionId, phase: "status", requestId,
  });
  assert.equal(status.phase, "status");
  assert.equal(status.message, undefined);
  assert.throws(() => parseRebootJsonInput({ action: "reboot", message: "No target" }), /Specify --session-id/);
  assert.throws(() => parseRebootJsonInput({ action: "reboot", sessionId, phase: "finalize" }), /require --request-id/);
  assert.throws(() => parseRebootJsonInput({ action: "reboot", sessionId, phase: "status", requestId, message: "Duplicate" }), /never resend/);
  assert.throws(() => parseRebootJsonInput({ action: "reload", sessionId, message: "Wrong action" }), /reboot action/);
  assert.throws(() => parseRebootJsonInput({ action: "reboot", sessionId, message: "Resume", unrecognized: true }), /Unknown or invalid/);
});
