import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { controlNativeThreads } from "./t3-native-threads.mjs";

const threadId = "f39d2467-d783-4578-8ba9-ccac017b1871";
const messageId = "6ad41909-57c8-43ed-a20f-742a43cd06a6";
const home = "D:\\fake\\t3code\\.t3";

function mockExchange(check, data = undefined) {
  return async (address, request, timeoutMs) => {
    assert.match(address, /t3code-app-/);
    assert.equal(timeoutMs, 95_000);
    check(request);
    return {
      version: 1,
      requestId: request.requestId,
      ok: true,
      data:
        data ??
        (request.action === "send"
          ? { environmentId: "t3-env", threadId, messageSent: true, messageId }
          : { environmentId: "t3-env", threads: [] }),
    };
  };
}

describe("native T3 local thread control CLI", () => {
  it("lists native threads using existing local pipe without credentials", async () => {
    const result = await controlNativeThreads(
      { action: "list" },
      {
        home,
        exchange: mockExchange((request) => {
          assert.equal(request.type, "t3.threads");
          assert.equal(request.action, "list");
          assert.equal(request.environmentId, undefined);
        }),
      },
    );
    assert.deepEqual(result, { environmentId: "t3-env", threads: [] });
  });

  it("forwards exact environment expectation for read", async () => {
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
          assert.equal(request.type, "t3.threads");
          assert.equal(request.action, "read");
          assert.equal(request.threadId, threadId);
          assert.equal(request.count, 3);
          assert.equal(request.environmentId, "t3-env");
        }),
      },
    );
  });

  it("acknowledges a native send with exactly the requested message ID", async () => {
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
          assert.equal(request.message, "Continue");
          assert.equal(request.clientRequestId, messageId);
          assert.equal(request.environmentId, "t3-env");
        }),
      },
    );
    assert.equal(result.messageSent, true);
    assert.equal(result.messageId, messageId);
  });

  it("fails closed on mismatched environment or unconfirmed delivery", async () => {
    await assert.rejects(
      controlNativeThreads(
        { action: "read", threadId, expectedEnvironmentId: "wrong" },
        { home, exchange: mockExchange(() => {}) },
      ),
      /wrong native environment/,
    );
    await assert.rejects(
      controlNativeThreads(
        { action: "send", threadId, message: "Continue", clientRequestId: messageId },
        {
          home,
          exchange: mockExchange(() => {}, {
            environmentId: "t3-env",
            messageSent: true,
            messageId: "other",
          }),
        },
      ),
      /acknowledgement; do not retry/,
    );
  });

  it("validates IDs, message length and read counts before touching desktop", async () => {
    const exchange = async () => {
      throw new Error("unexpected I/O");
    };
    for (const input of [
      { action: "read", threadId: "wrong" },
      { action: "send", threadId, message: "Hi", clientRequestId: "bad-id" },
      { action: "send", threadId, message: "   ", clientRequestId: messageId },
      { action: "send", threadId, message: "x".repeat(30_001), clientRequestId: messageId },
      { action: "read", threadId, count: 21 },
      { action: "list", message: "unexpected" },
    ])
      await assert.rejects(controlNativeThreads(input, { home, exchange }));
  });

  it("rejects request correlation mismatches", async () => {
    await assert.rejects(
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
