import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { controlSessions, waitForChatGPTSessions } from "./chatgpt-sessions.mjs";

const calls = [];
const exchange = async (address, request) => {
  calls.push({ address, request });
  return { version: 1, requestId: request.requestId, ok: true, data: { sessions: [], total: 0 } };
};
const options = { exchange, home: ".t3" };

NodeTest.test("list sends a correlated request on the existing local named pipe", async () => {
  const response = await controlSessions({ action: "list" }, options);
  NodeAssert.equal(response.total, 0);
  const call = calls.at(-1);
  NodeAssert.equal(call.request.version, 1);
  NodeAssert.equal(call.request.type, "chatgpt.sessions");
  NodeAssert.equal(call.request.action, "list");
  NodeAssert.equal(call.request.which, "visible");
  NodeAssert.match(call.address, /^\\\\\.\\pipe\\t3code-app-/);
});

NodeTest.test("list forwards all supported UI filters through the desktop socket", async () => {
  for (const which of ["visible", "recent", "working", "blocked", "all"]) {
    await controlSessions({ action: "list", which }, options);
    NodeAssert.equal(calls.at(-1).request.which, which);
  }
});

NodeTest.test("read forwards session selection and first/last count", async () => {
  await controlSessions({ action: "read", sessionId: "id-123", from: "start", count: 1 }, options);
  NodeAssert.equal(calls.at(-1).request.sessionId, "id-123");
  NodeAssert.equal(calls.at(-1).request.from, "start");
  NodeAssert.equal(calls.at(-1).request.count, 1);
});

NodeTest.test(
  "read forwards explicit bounded archive text length without changing ordinary reads",
  async () => {
    await controlSessions(
      { action: "read", sessionId: "id-123", count: 20, maxMessageChars: 24_000 },
      options,
    );
    NodeAssert.equal(calls.at(-1).request.maxMessageChars, 24_000);
    await controlSessions({ action: "read", sessionId: "id-123" }, options);
    NodeAssert.equal(calls.at(-1).request.maxMessageChars, undefined);
  },
);

NodeTest.test(
  "send forwards a message and optional caller-reported sender through the same local pipe",
  async () => {
    await controlSessions(
      {
        action: "send",
        sessionId: "id-123",
        message: "Continue implementing.",
        senderSessionId: "source-id",
      },
      options,
    );
    NodeAssert.equal(calls.at(-1).request.message, "Continue implementing.");
    NodeAssert.equal(calls.at(-1).request.senderSessionId, "source-id");
    await controlSessions({ action: "send", sessionId: "id-123", message: "Legacy" }, options);
    NodeAssert.equal(calls.at(-1).request.senderSessionId, undefined);
  },
);

const conversationId = "6ad4addb-8fc0-83eb-832c-47b147adffb2";

NodeTest.test(
  "guarded read forwards the expected conversation UUID and requires verification",
  async () => {
    const guardedOptions = {
      home: ".t3",
      exchange: async (_address, request) => {
        NodeAssert.equal(request.expectedConversationId, conversationId);
        return {
          ok: true,
          data: {
            session: { id: request.sessionId, conversationId },
            conversationGuardValidated: true,
            verifiedConversationId: conversationId,
          },
        };
      },
    };
    const result = await controlSessions(
      {
        action: "read",
        sessionId: "target",
        expectedConversationId: conversationId,
      },
      guardedOptions,
    );
    NodeAssert.equal(result.conversationGuardValidated, true);
    await NodeAssert.rejects(
      controlSessions(
        {
          action: "read",
          sessionId: "target",
          expectedConversationId: conversationId,
        },
        options,
      ),
      /did not confirm expectedConversationId/,
    );
  },
);

NodeTest.test(
  "guarded send probes the desktop contract before sending, then requires verified acknowledgement",
  async () => {
    const seen = [];
    const result = await controlSessions(
      {
        action: "send",
        sessionId: "target",
        message: "Safe update",
        expectedConversationId: conversationId,
      },
      {
        home: ".t3",
        exchange: async (_address, request) => {
          seen.push(request);
          NodeAssert.equal(request.expectedConversationId, conversationId);
          return {
            ok: true,
            data: {
              conversationGuardValidated: true,
              verifiedConversationId: conversationId,
              ...(request.action === "read"
                ? { session: { id: request.sessionId } }
                : {
                    messageSent: true,
                  }),
            },
          };
        },
      },
    );
    NodeAssert.deepEqual(
      seen.map((call) => call.action),
      ["read", "send"],
    );
    NodeAssert.equal(result.messageSent, true);
  },
);

NodeTest.test(
  "guarded send fails closed on old runtime, read mismatch and absent guard acknowledgement",
  async () => {
    for (const result of [
      { ok: true, data: { session: { conversationId } } },
      { ok: true, data: { conversationGuardValidated: true, verifiedConversationId: "other" } },
      { ok: false, code: "internal-error", message: "Mismatch" },
    ]) {
      const seen = [];
      await NodeAssert.rejects(
        controlSessions(
          {
            action: "send",
            sessionId: "target",
            message: "Never dispatch",
            expectedConversationId: conversationId,
          },
          {
            home: ".t3",
            exchange: async (_address, request) => {
              seen.push(request.action);
              return result;
            },
          },
        ),
        /refusing send/,
      );
      NodeAssert.deepEqual(seen, ["read"]);
    }
    let calls = 0;
    await NodeAssert.rejects(
      controlSessions(
        {
          action: "send",
          sessionId: "target",
          message: "No false ack",
          expectedConversationId: conversationId,
        },
        {
          home: ".t3",
          exchange: async () => {
            calls++;
            return calls === 1
              ? {
                  ok: true,
                  data: {
                    conversationGuardValidated: true,
                    verifiedConversationId: conversationId,
                  },
                }
              : { ok: true, data: { messageSent: true } };
          },
        },
      ),
      /did not confirm expectedConversationId/,
    );
    NodeAssert.equal(calls, 2);
  },
);

NodeTest.test("rejects invalid operations before contacting the running app", async () => {
  const count = calls.length;
  await NodeAssert.rejects(controlSessions({ action: "read" }, options), /sessionId is required/);
  await NodeAssert.rejects(
    controlSessions({ action: "send", sessionId: "id" }, options),
    /message required/,
  );
  await NodeAssert.rejects(controlSessions({ action: "unknown" }, options), /action must be/);
  await NodeAssert.rejects(
    controlSessions({ action: "read", sessionId: "id", senderSessionId: "source" }, options),
    /senderSessionId/,
  );
  await NodeAssert.rejects(
    controlSessions(
      { action: "send", sessionId: "id", message: "ok", senderSessionId: " " },
      options,
    ),
    /senderSessionId/,
  );
  await NodeAssert.rejects(
    controlSessions({ action: "list", which: "banana" }, options),
    /which applies only/,
  );
  await NodeAssert.rejects(
    controlSessions({ action: "read", which: "recent", sessionId: "id" }, options),
    /which applies only/,
  );
  for (const invalid of [
    "",
    "NOT-A-UUID",
    conversationId.toUpperCase(),
    `https://chatgpt.com/c/${conversationId}`,
  ]) {
    await NodeAssert.rejects(
      controlSessions(
        {
          action: "send",
          sessionId: "target",
          message: "unsafe",
          expectedConversationId: invalid,
        },
        options,
      ),
      /expectedConversationId/,
    );
  }
  await NodeAssert.rejects(
    controlSessions(
      {
        action: "list",
        expectedConversationId: conversationId,
      },
      options,
    ),
    /expectedConversationId/,
  );
  NodeAssert.equal(calls.length, count);
});

NodeTest.test("complete uses an explicit browser session ID through the desktop pipe", async () => {
  await controlSessions({ action: "complete", sessionId: "agent-A" }, options);
  NodeAssert.equal(calls.at(-1).request.action, "complete");
  NodeAssert.equal(calls.at(-1).request.sessionId, "agent-A");
});

function fakeWait(completedInPolls) {
  let clock = 0;
  let calls = 0;
  const options = {
    now: () => clock,
    delay: async (ms) => {
      clock += ms;
    },
    exchange: async (address, request) => {
      const poll = Math.floor(calls++ / completedInPolls[0].length);
      const agentIndex = completedInPolls[0].indexOf(request.sessionId);
      const declared = completedInPolls[1][poll]?.includes(request.sessionId) ?? false;
      if (agentIndex < 0) throw new Error("Unexpected session requested");
      return {
        ok: true,
        data: {
          session: {
            id: request.sessionId,
            status: declared ? "done_or_idle" : "working",
            completion: declared
              ? {
                  declaredAt: "2026-10-18T12:00:00Z",
                  observedTurns: 1,
                  observedUrl: "https://chatgpt.com/c/test",
                }
              : null,
          },
        },
      };
    },
  };
  return options;
}

NodeTest.test(
  "wait ANY returns the first explicitly completed worker without waiting for every worker",
  async () => {
    const options = fakeWait([
      ["A", "B"],
      [[], ["B"], ["A", "B"]],
    ]);
    const result = await waitForChatGPTSessions(
      {
        action: "wait",
        sessionIds: ["A", "B"],
        mode: "any",
        timeoutMs: 10_000,
        pollMs: 1_000,
      },
      options,
    );
    NodeAssert.deepEqual(result.matched, ["B"]);
    NodeAssert.deepEqual(result.pending, ["A"]);
    NodeAssert.equal(result.completed, true);
    NodeAssert.equal(result.elapsedMs, 1000);
  },
);

NodeTest.test("wait ALL requires all workers' explicit signals, not just idle status", async () => {
  const options = fakeWait([
    ["A", "B"],
    [[], ["B"], ["A", "B"]],
  ]);
  const result = await waitForChatGPTSessions(
    {
      action: "wait",
      sessionIds: ["A", "B"],
      mode: "all",
      timeoutMs: 10_000,
      pollMs: 1_000,
    },
    options,
  );
  NodeAssert.deepEqual(result.matched, ["A", "B"]);
  NodeAssert.equal(result.elapsedMs, 2000);
  NodeAssert.equal(result.completed, true);
});

NodeTest.test(
  "wait returns a truthful timeout and pending IDs, never a false completion",
  async () => {
    const result = await waitForChatGPTSessions(
      {
        action: "wait",
        sessionId: "A",
        timeoutMs: 0,
        pollMs: 1_000,
      },
      {
        now: (() => {
          let clock = 0;
          return () => clock;
        })(),
        exchange: async (_address, request) => ({
          ok: true,
          data: { session: { status: "done_or_idle", completion: null, id: request.sessionId } },
        }),
        delay: async () => {},
      },
    );
    NodeAssert.equal(result.completed, false);
  },
);

NodeTest.test("wait validates duplicate/unknown IDs and modes before doing work", async () => {
  await NodeAssert.rejects(waitForChatGPTSessions({ sessionIds: ["a", "a"] }), /distinct/);
  await NodeAssert.rejects(waitForChatGPTSessions({ sessionIds: ["a"], mode: "first" }), /mode/);
});

NodeTest.test("does not report success for older T3 versions without this response", async () => {
  await NodeAssert.rejects(
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

NodeTest.test("returns T3 failures unchanged", async () => {
  await NodeAssert.rejects(
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
