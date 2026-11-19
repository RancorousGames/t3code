import * as Test from "node:test";
import * as Assert from "node:assert/strict";
import { sendMcpMessage, readDesktopMessageReceipt } from "./t3-mcp-message-route.mjs";

const SESSION = "8b1a927a-dd8f-4fd7-a982-c335ea5552b5";
const NATIVE = "7ed3b062-4c47-4680-855a-d7bd2b503726";
const CONVERSATION = "6afea43a-cbc0-83ed-8456-9eab77a8220f";
const REQUEST = "4832dce7-6ec9-4f38-879c-11d519bc1e35";
const ENV = "522cb823-71c8-4e9f-b668-dbe1faa9ec55";

Test.test(
  "MCP send reaches a live ChatGPT desktop session absent from server registry",
  async () => {
    const calls = [];
    const browser = async (input) => {
      calls.push(input);
      if (input.action === "list")
        return {
          sessions: [
            {
              id: SESSION,
              url: `https://chatgpt.com/c/${CONVERSATION}`,
              conversationId: CONVERSATION,
            },
          ],
        };
      if (input.action === "enqueue")
        return {
          messageId: input.messageId,
          conversationId: input.expectedConversationId,
          sessionId: input.sessionId,
          status: "queued",
        };
      throw new Error("Unexpected browser action");
    };
    const native = async () => {
      throw new Error("Native list must not be consulted for a browser recipient");
    };
    const sent = await sendMcpMessage(
      { action: "send", sessionId: SESSION, message: "Hello", requestId: REQUEST },
      { browser, native },
    );
    Assert.equal(sent.status, "queued");
    Assert.equal(sent.queueAccepted, true);
    Assert.equal(sent.messageSent, false);
    Assert.equal(calls[1].action, "enqueue");
    Assert.equal(calls[1].messageId, REQUEST);
    Assert.equal(calls[1].expectedConversationId, CONVERSATION);
    const wrong = await sendMcpMessage(
      {
        action: "send",
        sessionId: SESSION,
        message: "Hello",
        requestId: REQUEST,
        expectedConversationId: "00000000-0000-4000-8000-000000000111",
      },
      { browser, native },
    );
    Assert.equal(wrong.status, "refused");
    Assert.equal(calls.length, 3); // second request only inspected the desktop list
    const received = await readDesktopMessageReceipt(
      { requestId: REQUEST },
      {
        browser: async () => ({
          messageId: REQUEST,
          sessionId: SESSION,
          status: "delivered",
          attempts: 1,
        }),
      },
    );
    Assert.equal(received.messageSent, true);
    Assert.equal(received.resolved, true);
  },
);

Test.test(
  "MCP send routes an exact native T3 thread without a ChatGPT conversation guard",
  async () => {
    const calls = [];
    const browser = async () => ({ sessions: [] });
    const native = async (input) => {
      calls.push(input);
      if (input.action === "list") return { environmentId: ENV, threads: [{ id: NATIVE }] };
      return { threadId: input.threadId, messageId: input.clientRequestId, messageSent: true };
    };
    const result = await sendMcpMessage(
      { action: "send", sessionId: NATIVE, message: "Native hello", requestId: REQUEST },
      { browser, native },
    );
    Assert.equal(result.status, "delivered");
    Assert.equal(result.delivery, "native_message_acknowledged");
    Assert.equal(calls[1].environmentId, ENV);
    Assert.equal(calls[1].clientRequestId, REQUEST);
  },
);

Test.test(
  "Unknown IDs are refused instead of becoming indefinitely queued server actions",
  async () => {
    const result = await sendMcpMessage(
      { action: "send", sessionId: SESSION, message: "Do not queue", requestId: REQUEST },
      {
        browser: async () => ({ sessions: [] }),
        native: async () => ({ environmentId: ENV, threads: [] }),
      },
    );
    Assert.equal(result.status, "refused");
    Assert.equal(result.messageSent, false);
  },
);
