import assert from "node:assert/strict";
import { test } from "node:test";
import { controlSessions } from "./chatgpt-sessions.mjs";

const token = "T3_SELF_0123456789ABCDEF0123456789ABCDEF";
test("CLI forwards exact marker only to an explicit session", async () => {
  const requests = [];
  const exchange = async (_address, req) => {
    requests.push(req);
    return {
      requestId: req.requestId,
      ok: true,
      data: { sessionId: req.sessionId, status: "inspected", markerFound: true },
    };
  };
  const result = await controlSessions(
    { action: "marker_probe", sessionId: "test-session", marker: token },
    { exchange },
  );
  assert.equal(result.markerFound, true);
  assert.equal(requests[0].action, "marker_probe");
  assert.equal(requests[0].marker, token);
  assert.equal(requests[0].sessionId, "test-session");
});
test("invalid or misplaced markers are rejected", async () => {
  await assert.rejects(
    () => controlSessions({ action: "marker_probe", sessionId: "A", marker: "bad" }),
    /marker/,
  );
  await assert.rejects(
    () => controlSessions({ action: "read", sessionId: "A", marker: token }),
    /marker/,
  );
});
