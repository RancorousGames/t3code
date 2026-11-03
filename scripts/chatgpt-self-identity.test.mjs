import assert from "node:assert/strict";
import { test } from "node:test";
import { newSelfMarker, findSelfMarkerSessions } from "./chatgpt-self-marker.mjs";
import { controlSelf, identifySelfSession } from "./chatgpt-self-identity.mjs";

const id = "2a15b81a-4041-4fdc-bb1d-2d5ed99a3d9a";
const marker = "T3_SELF_0123456789ABCDEF0123456789ABCDEF";
const fakeSessions = (entries) => ({
  exchange: async (_address, req) => ({
    version: 1,
    requestId: req.requestId,
    ok: true,
    data: { sessions: entries },
  }),
});

test("a fresh marker is independent of the T3 or ChatGPT session ID", async () => {
  const result = await controlSelf({ action: "identify_self" });
  assert.match(result.marker, /^T3_SELF_[A-F0-9]{32}$/);
  assert.notEqual(result.marker, newSelfMarker());
});

test("matches only one visible assistant, not prompts or hidden sessions", () => {
  const records = [
    {
      id,
      hidden: false,
      lastRole: "assistant",
      lastText: "Hi",
      latestMessageFirstFiveWords: marker + " done",
    },
    { id: "user-prompt", hidden: false, lastRole: "user", lastText: marker },
    { id: "hidden", hidden: true, lastRole: "assistant", lastText: marker },
    { id: "other", hidden: false, lastRole: "assistant", lastText: "unrelated" },
  ];
  assert.deepEqual(findSelfMarkerSessions(records, marker), [id]);
  assert.throws(() => findSelfMarkerSessions(records, "not-a-marker"), /Invalid/);
});

test("resolves sender without accepting a session ID", async () => {
  const ports = fakeSessions([{ id, hidden: false, lastRole: "assistant", lastText: marker }]);
  assert.equal(await identifySelfSession(marker, ports), id);
  assert.deepEqual(await controlSelf({ action: "resolve_self", marker }, ports), {
    action: "resolve_self",
    sessionId: id,
  });
});

test("refuses ambiguity and absent markers without reboot", async () => {
  for (const entries of [
    [],
    [
      { id, hidden: false, lastRole: "assistant", lastText: marker },
      { id: "another", hidden: false, lastRole: "assistant", lastText: marker },
    ],
  ]) {
    await assert.rejects(() =>
      controlSelf({ action: "reboot_self", marker, message: "Resume" }, fakeSessions(entries)),
    );
  }
});

test("reboot_self targets exactly the browser containing its marker", async () => {
  const requests = [];
  const exchange = async (_address, request) => {
    requests.push(request);
    if (request.type === "chatgpt.sessions")
      return {
        version: 1,
        requestId: request.requestId,
        ok: true,
        data: {
          sessions: [
            { id: "not-this-one", lastRole: "assistant", lastText: "working" },
            { id, lastRole: "assistant", lastText: "Marker confirmed " + marker },
          ],
        },
      };
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      data: { action: "reboot", sessionId: id, rebootGeneration: 3, status: "submitted" },
    };
  };
  const result = await controlSelf(
    { action: "reboot_self", marker, message: "Resume existing task" },
    { exchange },
  );
  assert.equal(result.sessionId, id);
  assert.equal(result.rebootGeneration, 3);
  assert.deepEqual(
    requests.map((r) => r.type),
    ["chatgpt.sessions", "chatgpt.reboot"],
  );
  assert.equal(requests[1].sessionId, id);
  assert.equal(requests[1].prompt, "Resume existing task");
});

// In real use a second user turn causes lastRole to be 'user' when the agent calls
// resolve_self. The marker remains in the preceding assistant turn, not lastText.
test("resolves marker from previous assistant turn while new user turn is active", async () => {
  const seen = [];
  const exchange = async (_address, request) => {
    seen.push(request);
    if (request.action === "list")
      return {
        version: 1,
        requestId: request.requestId,
        ok: true,
        data: {
          sessions: [
            {
              id,
              hidden: false,
              status: "working",
              totalTurns: 2,
              lastRole: "user",
              lastText: "Next test",
            },
            {
              id: "different",
              hidden: false,
              status: "done_or_idle",
              totalTurns: 1,
              lastRole: "assistant",
              lastText: "Nothing relevant",
            },
          ],
        },
      };
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      data: {
        session: {
          messages:
            request.sessionId === id
              ? [
                  { role: "assistant", text: marker },
                  { role: "user", text: "Next test" },
                ]
              : [{ role: "assistant", text: "No marker" }],
        },
      },
    };
  };
  assert.equal(await identifySelfSession(marker, { exchange }), id);
  assert.deepEqual(
    seen.map((x) => x.action),
    ["list", "read", "read"],
  );
});

test("a user merely quoting a marker is not assistant evidence", () => {
  assert.deepEqual(
    findSelfMarkerSessions(
      [{ id, lastRole: "user", lastText: marker, messages: [{ role: "user", text: marker }] }],
      marker,
    ),
    [],
  );
});

test("unconfirmed reboot is reconciled by status with same requestId, never repeated begin", async () => {
  const calls = [];
  const exchange = async (_address, request) => {
    calls.push(request);
    if (request.type === "chatgpt.sessions")
      return {
        version: 1,
        requestId: request.requestId,
        ok: true,
        data: { sessions: [{ id, lastRole: "assistant", lastText: marker }] },
      };
    if (request.phase === "begin")
      return {
        version: 1,
        requestId: request.requestId,
        ok: false,
        code: "chatgpt-send-failed",
        message: "Reboot submit unconfirmed",
      };
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      data: { action: "reboot", sessionId: id, rebootGeneration: 1, status: "submitted" },
    };
  };
  const result = await controlSelf(
    { action: "reboot_self", marker, message: "Continue" },
    { exchange },
  );
  assert.equal(result.status, "submitted");
  assert.equal(result.sessionId, id);
  const rebootCalls = calls.filter((c) => c.type === "chatgpt.reboot");
  assert.deepEqual(
    rebootCalls.map((c) => c.phase),
    ["begin", "status"],
  );
  assert.equal(rebootCalls[0].requestId, rebootCalls[1].requestId);
  assert.equal(rebootCalls[1].prompt, undefined);
});

test("resolves tool-output-only marker without assistant echo", async () => {
  const requests = [];
  const exchange = async (_addr, req) => {
    requests.push(req);
    if (req.action === "list")
      return {
        requestId: req.requestId,
        ok: true,
        data: {
          sessions: [
            {
              id,
              hidden: false,
              totalTurns: 1,
              status: "done_or_idle",
              lastRole: "assistant",
              lastText: "TOOL_OUTPUT_PROBE_DONE",
            },
            {
              id: "unrelated",
              hidden: false,
              totalTurns: 1,
              status: "done_or_idle",
              lastRole: "assistant",
              lastText: "nothing",
            },
          ],
        },
      };
    if (req.action === "marker_probe")
      return {
        requestId: req.requestId,
        ok: true,
        data: {
          status: "inspected",
          sessionId: req.sessionId,
          markerFound: req.sessionId === id,
        },
      };
    throw new Error("Unexpected assistant-history read");
  };
  assert.equal(await identifySelfSession(marker, { exchange }), id);
  assert.deepEqual(
    requests.map((x) => x.action),
    ["list", "read", "read", "marker_probe", "marker_probe"],
  );
});

test("refuses ambiguous tool-output markers without assistant fallback", async () => {
  const exchange = async (_addr, req) => {
    if (req.action === "list")
      return {
        requestId: req.requestId,
        ok: true,
        data: {
          sessions: [
            { id, hidden: false, totalTurns: 1, status: "done_or_idle" },
            { id: "unrelated", hidden: false, totalTurns: 1, status: "done_or_idle" },
          ],
        },
      };
    return {
      requestId: req.requestId,
      ok: true,
      data: {
        status: "inspected",
        sessionId: req.sessionId,
        markerFound: true,
      },
    };
  };
  await assert.rejects(() => identifySelfSession(marker, { exchange }), /ambiguous/);
});
