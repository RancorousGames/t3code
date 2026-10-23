import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { controlNativeThreads } from "./t3-native-threads.mjs";

const threadId = "f39d2467-d783-4578-8ba9-ccac017b1871";
const messageId = "6ad41909-57c8-43ed-a20f-742a43cd06a6";
const home = "D:\\fake\\t3code\\.t3";

function mockExchange(check, data = undefined) {
  return async (address, request, timeoutMs) => {
    NodeAssert.match(address, /t3code-app-/);
    NodeAssert.equal(timeoutMs, 95_000);
    check(request);
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      data:
        data ??
        (request.action === "send"
          ? { environmentId: "t3-env", threadId: request.threadId, messageSent: true, messageId }
          : request.action === "read"
            ? { environmentId: "t3-env", threadId: request.threadId, messages: [] }
            : { environmentId: "t3-env", threads: [] }),
    };
  };
}

// Test only: mocks a future RUNNING desktop capability advertisement in the
// existing v1 read-only list response. Never talks to the live control pipe.
function withOpaqueProof(sendExchange, {
  environmentId = "t3-env", read = true, send = true,
  grammar = "t3-native-opaque-read-send-v1", omit = false,
} = {}) {
  return async (address, request, timeoutMs) => {
    if (request.action === "list") {
      NodeAssert.match(address, /t3code-app-/);
      NodeAssert.equal(timeoutMs, 95_000);
      return {
        version: 1, requestId: request.requestId, ok: true,
        data: {
          environmentId, threads: [],
          ...(!omit ? { nativeThreadMessaging: {
            version: 1, environmentId, threadIdGrammar: grammar,
            readOpaqueThreadIds: read, sendOpaqueThreadIds: send,
          } } : {}),
        },
      };
    }
    return sendExchange(address, request, timeoutMs);
  };
}

NodeTest.describe("native T3 local thread control CLI", () => {
  NodeTest.it("lists native threads using existing local pipe without credentials", async () => {
    const result = await controlNativeThreads(
      { action: "list" },
      {
        home,
        exchange: mockExchange((request) => {
          NodeAssert.equal(request.type, "t3.threads");
          NodeAssert.equal(request.action, "list");
          NodeAssert.equal(request.environmentId, undefined);
        }),
      },
    );
    NodeAssert.deepEqual(result, { environmentId: "t3-env", threads: [] });
  });

  NodeTest.it("forwards exact environment expectation for read", async () => {
    await controlNativeThreads(
      {
        action: "read",
        threadId,
        count: 3,
        expectedEnvironmentId: "t3-env",
      },
      {
        home,
        exchange: mockExchange((request) => {
          NodeAssert.equal(request.type, "t3.threads");
          NodeAssert.equal(request.action, "read");
          NodeAssert.equal(request.threadId, threadId);
          NodeAssert.equal(request.count, 3);
          NodeAssert.equal(request.environmentId, "t3-env");
        }),
      },
    );
  });

  NodeTest.it("acknowledges a native send with exactly the requested message ID", async () => {
    const result = await controlNativeThreads(
      {
        action: "send",
        threadId,
        message: "Continue",
        clientRequestId: messageId,
        expectedEnvironmentId: "t3-env",
      },
      {
        home,
        exchange: mockExchange((request) => {
          NodeAssert.equal(request.message, "Continue");
          NodeAssert.equal(request.clientRequestId, messageId);
          NodeAssert.equal(request.environmentId, "t3-env");
        }),
      },
    );
    NodeAssert.equal(result.messageSent, true);
    NodeAssert.equal(result.messageId, messageId);
  });

  NodeTest.it("fails closed on mismatched environment or unconfirmed delivery", async () => {
    await NodeAssert.rejects(
      controlNativeThreads(
        { action: "read", threadId, expectedEnvironmentId: "wrong" },
        { home, exchange: mockExchange(() => {}) },
      ),
      /wrong native environment/,
    );
    await NodeAssert.rejects(
      controlNativeThreads(
        { action: "send", threadId, message: "Continue", clientRequestId: messageId },
        {
          home,
          exchange: mockExchange(() => {}, {
            environmentId: "t3-env",
            threadId,
            messageSent: true,
            messageId: "other",
          }),
        },
      ),
      /acknowledgement; do not retry/,
    );
  });

  NodeTest.it("routes existing UUID and opaque MCP thread IDs verbatim through the same local pipe", async () => {
    const ids = [
      threadId,
      "mcp:d92d7667-7b13-4bd8-868f-230ede021e8b",
      "thread:mcp:source:child",
      "thread:mcp:source%3Aworker%2Fchild:0",
      "thread:mcp:a%25b:0",
    ];
    for (const id of ids) {
      for (const action of ["read", "send"]) {
        let exchanges = 0;
        const request = { action, threadId: id, expectedEnvironmentId: "t3-env",
          ...(action === "send" ? { message: "Exact message", clientRequestId: messageId } : { count: 2 }) };
        const actual = mockExchange((outbound) => {
          exchanges++;
          NodeAssert.equal(outbound.threadId, id, "must not URL-decode or rewrite the thread ID");
          NodeAssert.equal(outbound.environmentId, "t3-env");
          NodeAssert.equal(outbound.action, action);
          NodeAssert.equal(outbound.type, "t3.threads");
        });
        const result = await controlNativeThreads(request, {
          home, exchange: withOpaqueProof(actual),
        });
        NodeAssert.equal(result.threadId, id);
        NodeAssert.equal(exchanges, 1);
      }
    }
  });

  NodeTest.it("rejects wrong recipient receipts, absent environment and malformed read response without retry", async () => {
    const opaque = "thread:mcp:server%3Aworker:0";
    for (const action of ["read", "send"]) {
      const request = { action, threadId: opaque, expectedEnvironmentId: "t3-env",
        ...(action === "send" ? { message: "Continue", clientRequestId: messageId } : { count: 2 }) };
      for (const override of [
        { threadId: "mcp:d92d7667-7b13-4bd8-868f-230ede021e8b" },
        { environmentId: "" },
      ]) {
        let exchanges = 0;
        await NodeAssert.rejects(controlNativeThreads(request, {
          home,
          exchange: withOpaqueProof(mockExchange(() => { exchanges++; }, {
            environmentId: "t3-env", threadId: opaque,
            ...(action === "send" ? { messageSent: true, messageId } : { messages: [] }),
            ...override,
          })),
        }), /recipient|environment/);
        NodeAssert.equal(exchanges, 1);
      }
    }
    await NodeAssert.rejects(controlNativeThreads({
      action: "read", threadId: opaque, expectedEnvironmentId: "t3-env",
    }, {
      home,
      exchange: withOpaqueProof(mockExchange(() => {}, { environmentId: "t3-env", threadId: opaque, threads: [] })),
    }), /lacked a message list/);
  });

  NodeTest.it("requires BOTH read and send opaque capability flags from the running exact environment", async () => {
    const id = "thread:mcp:server%3Aworker:0";
    const input = { action: "send", threadId: id, expectedEnvironmentId: "t3-env",
      message: "Do not send", clientRequestId: messageId };
    for (const capabilities of [
      { omit: true }, { read: false }, { send: false }, { environmentId: "wrong-env" },
      { grammar: "unrecognized-grammar" },
    ]) {
      let sends = 0;
      await NodeAssert.rejects(controlNativeThreads(input, {
        home,
        exchange: withOpaqueProof(async () => { sends++; throw Error("unsafe send"); }, capabilities),
      }), /capability; UUID-only/);
      NodeAssert.equal(sends, 0, "read-only proof must fail before dispatch");
    }
    await NodeAssert.rejects(controlNativeThreads({
      ...input, expectedEnvironmentId: undefined,
    }, { home, exchange: async () => { throw Error("unexpected I/O"); } }),
      /requires exact expectedEnvironmentId/);
  });

  NodeTest.it("validates IDs, message length and read counts before touching desktop", async () => {
    const exchange = async () => {
      throw new Error("unexpected I/O");
    };
    for (const input of [
      { action: "read", threadId: "wrong" },
      { action: "read", threadId: "mcp:" },
      { action: "send", threadId: "mcp:fake", message: "Hello", clientRequestId: messageId },
      { action: "read", threadId: "thread:mcp:" },
      { action: "read", threadId: "thread:mcp:segment%2" },
      { action: "read", threadId: "thread:mcp:segment%GG" },
      { action: "read", threadId: "thread:mcp:%0A:next" },
      { action: "read", threadId: "thread:mcp:%FF:next" },
      { action: "read", threadId: "thread:mcp:%20:next" },
      { action: "read", threadId: "thread:mcp:%7f:next" },
      { action: "read", threadId: "thread:mcp:a/b" },
      { action: "read", threadId: "thread:mcp:a?b" },
      { action: "read", threadId: "thread:mcp: a" },
      { action: "read", threadId: "thread:mcp:alpha".padEnd(270, "x") },
      { action: "read", threadId: "mcp:d92d7667-7b13-4bd8-868f-230ede021e8b\n" },
      { action: "send", threadId, message: "Hi", clientRequestId: "bad-id" },
      { action: "send", threadId, message: "   ", clientRequestId: messageId },
      { action: "send", threadId, message: "x".repeat(30_001), clientRequestId: messageId },
      { action: "read", threadId, count: 21 },
      { action: "list", message: "unexpected" },
    ])
      await NodeAssert.rejects(controlNativeThreads(input, { home, exchange }));
  });

  NodeTest.it("rejects request correlation mismatches", async () => {
    await NodeAssert.rejects(
      controlNativeThreads(
        { action: "list" },
        {
          home,
          exchange: async () => ({
            version: 1,
            requestId: "wrong",
            ok: true,
            data: { environmentId: "t3-env", threads: [] },
          }),
        },
      ),
      /correlation/,
    );
  });
});


NodeTest.describe("managed persistent native thread create", () => {
  const createId = "7a046ce0-4a77-4b4a-a78c-66d3699d5c00";
  const firstMessageId = "763df61c-87b0-48b4-a771-01d72a303516";
  const projectId = "c5b2d999-7c69-4709-93c9-735d76b463c7";
  const base = {
    action: "create",
    expectedEnvironmentId: "t3-env",
    workspaceRoot: "D:\\SSDProjects\\Tools\\t3code",
    runtime: "claude",
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-5" },
    runtimeMode: "approval-required",
    title: "Managed worker",
    clientRequestId: createId,
  };
  function receipt(request) {
    return {
      action: "create",
      environmentId: request.environmentId,
      projectId,
      threadId: request.clientRequestId,
      workspaceRoot: request.workspaceRoot,
      runtime: request.runtime,
      providerInstanceId: request.providerInstanceId,
      modelSelection: request.modelSelection,
      created: true,
      ...(request.firstMessage !== undefined
        ? { messageSent: true, messageId: request.initialMessageId }
        : { messageSent: false }),
    };
  }
  const exchange = (check, mutate = (data) => data) => async (_, request) => {
    check(request);
    return {
      version: 1, requestId: request.requestId, ok: true,
      data: mutate(receipt(request)),
    };
  };
  NodeTest.it("uses exact runtime/model/workspace and stable UUID thread ID, without a draft", async () => {
    const created = await controlNativeThreads(base, {
      home,
      exchange: exchange((request) => {
        NodeAssert.equal(request.action, "create");
        NodeAssert.equal(request.environmentId, "t3-env");
        NodeAssert.equal(request.workspaceRoot, base.workspaceRoot);
        NodeAssert.equal(request.providerInstanceId, "claudeAgent");
        NodeAssert.deepEqual(request.modelSelection, base.modelSelection);
        NodeAssert.equal(request.runtimeMode, "approval-required");
        NodeAssert.equal(request.clientRequestId, createId);
        NodeAssert.equal(request.threadId, undefined);
        NodeAssert.equal(request.firstMessage, undefined);
      }),
    });
    NodeAssert.equal(created.threadId, createId);
    NodeAssert.equal(created.messageSent, false);
  });
  NodeTest.it("creates an explicit OpenCode root with the exact catalog slug, workspace and durable first-message receipt", async () => {
    const request = {
      ...base,
      workspaceRoot: "D:\\SSDProjects\\SettlingAltraea",
      runtime: "opencode",
      providerInstanceId: "opencode",
      modelSelection: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
      firstMessage: "Inspect the existing Altraea Git changes, do not commit without approval.",
      initialMessageId: firstMessageId,
    };
    let exchanged = 0;
    const created = await controlNativeThreads(request, {
      home,
      exchange: exchange((wire) => {
        exchanged++;
        NodeAssert.equal(wire.environmentId, "t3-env");
        NodeAssert.equal(wire.workspaceRoot, request.workspaceRoot);
        NodeAssert.equal(wire.runtime, "opencode");
        NodeAssert.equal(wire.providerInstanceId, "opencode");
        NodeAssert.deepEqual(wire.modelSelection, request.modelSelection);
        NodeAssert.equal(wire.clientRequestId, createId);
        NodeAssert.equal(wire.firstMessage, request.firstMessage);
        NodeAssert.equal(wire.initialMessageId, firstMessageId);
        NodeAssert.equal(wire.parentThreadId, undefined);
      }),
    });
    NodeAssert.equal(exchanged, 1);
    NodeAssert.equal(created.threadId, createId);
    NodeAssert.equal(created.runtime, "opencode");
    NodeAssert.equal(created.providerInstanceId, "opencode");
    NodeAssert.equal(created.modelSelection.model, "opencode/deepseek-v4.1-flash-free");
    NodeAssert.equal(created.messageSent, true);
    NodeAssert.equal(created.messageId, firstMessageId);
  });
  NodeTest.it("rejects missing or mismatched OpenCode model/instance/receipt without retrying", async () => {
    const openCode = { ...base, runtime: "opencode", providerInstanceId: "opencode",
      modelSelection: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" } };
    for (const patch of [
      { providerInstanceId: "codex" },
      { modelSelection: { instanceId: "claudeAgent", model: "opencode/deepseek-v4.1-flash-free" } },
      { modelSelection: { instanceId: "opencode", model: "" } },
      { runtime: "cursor" },
    ]) {
      await NodeAssert.rejects(controlNativeThreads({ ...openCode, ...patch }, {
        home, exchange: async () => { throw Error("unexpected I/O"); },
      }), (error) => {
        NodeAssert.doesNotMatch(error.message, /unexpected I\/O/);
        return true;
      });
    }
    let sends = 0;
    await NodeAssert.rejects(controlNativeThreads(openCode, {
      home, exchange: exchange(() => { sends++; }, (receiptData) => ({
        ...receiptData, modelSelection: { instanceId: "opencode", model: "different" },
      })),
    }), /acknowledgement.*do not retry/);
    NodeAssert.equal(sends, 1);
  });
  NodeTest.it("requires exact accepted initial message ID and never automatically retries", async () => {
    let requests = 0;
    const created = await controlNativeThreads({
      ...base, firstMessage: "Do the work", initialMessageId: firstMessageId,
    }, {
      home,
      exchange: exchange((request) => {
        requests++;
        NodeAssert.equal(request.firstMessage, "Do the work");
        NodeAssert.equal(request.initialMessageId, firstMessageId);
      }),
    });
    NodeAssert.equal(created.messageId, firstMessageId);
    NodeAssert.equal(requests, 1);
    await NodeAssert.rejects(
      controlNativeThreads({ ...base, firstMessage: "Do the work", initialMessageId: firstMessageId }, {
        home,
        exchange: exchange(() => { requests++; }, (data) => ({ ...data, messageId: "wrong" })),
      }),
      /acknowledgement.*do not retry/,
    );
    NodeAssert.equal(requests, 2);
  });
  NodeTest.it("rejects mismatched provider, project, thread, root and fabricated persistence", async () => {
    for (const patch of [
      { created: false },
      { threadId: threadId },
      { projectId: threadId },
      { providerInstanceId: "codex" },
      { modelSelection: { instanceId: "codex", model: "claude-sonnet-4-5" } },
      { workspaceRoot: "D:\\Other" },
    ]) {
      await NodeAssert.rejects(controlNativeThreads({ ...base, projectId }, {
        home,
        exchange: exchange(() => {}, (data) => ({ ...data, ...patch })),
      }), /acknowledgement.*do not retry/);
    }
  });
  NodeTest.it("fails before I/O on unspecified provider, model or invalid workspace", async () => {
    for (const patch of [
      { expectedEnvironmentId: undefined },
      { workspaceRoot: "relative-path" },
      { providerInstanceId: "codex" },
      { modelSelection: undefined },
      { modelSelection: { instanceId: "codex", model: "gpt-5" } },
      { runtime: "unknown" },
      { runtimeMode: undefined },
      { clientRequestId: "not-id" },
      { firstMessage: "hi" },
      { initialMessageId: firstMessageId },
      { threadId },
    ]) {
      await NodeAssert.rejects(controlNativeThreads({ ...base, ...patch }, {
        home,
        exchange: async () => { throw Error("I/O must not occur"); },
      }), (error) => {
        NodeAssert.doesNotMatch(error.message, /I\/O must not occur/);
        return true;
      });
    }
  });
});


NodeTest.describe("authoritative T3 native provider discovery", () => {
  NodeTest.it("reads scoped catalog without inheriting UI or model defaults", async () => {
    const models = [{ slug: "gpt-5-codex", isDefault: true }];
    const providers = [{
      providerInstanceId: "codex", driver: "codex", enabled: true,
      installed: true, status: "ready", available: true, models,
    }];
    const result = await controlNativeThreads(
      { action: "providers", expectedEnvironmentId: "t3-env" },
      { home, exchange: async (_, request) => {
        NodeAssert.equal(request.action, "providers");
        NodeAssert.equal(request.environmentId, "t3-env");
        return {
          version: 1, requestId: request.requestId, ok: true,
          data: { environmentId: "t3-env", providers },
        };
      } },
    );
    NodeAssert.deepEqual(result.providers, providers);
  });
  NodeTest.it("fails closed when desktop has no valid provider catalog", async () => {
    await NodeAssert.rejects(
      controlNativeThreads(
        { action: "providers" },
        { home, exchange: async (_, request) => ({
          version: 1, requestId: request.requestId, ok: true,
          data: { environmentId: "t3-env", providers: [{ providerInstanceId: "codex" }] },
        }) },
      ),
      /catalog response malformed/,
    );
  });
});
