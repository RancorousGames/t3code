import * as NodeAssert from "node:assert/strict";
import * as NodeNet from "node:net";
import * as NodeTest from "node:test";

import { parseArguments, sendAppControlRequest } from "./spawn-chatgpt-session.mjs";

NodeTest.test("script validates title and message without connecting", () => {
  NodeAssert.deepEqual(
    parseArguments(["--title", "Work A", "--message", "Review D43"]).title,
    "Work A",
  );
  NodeAssert.deepEqual(
    (({ parentSessionId, project }) => ({ parentSessionId, project }))(
      parseArguments([
        "--title",
        "Work A",
        "--message",
        "Run tests",
        "--parent-session-id",
        "parent-42",
        "--project",
        "Wartribes",
      ]),
    ),
    { parentSessionId: "parent-42", project: "Wartribes" },
  );
  NodeAssert.equal(parseArguments(["--help"]), null);
  NodeAssert.throws(() => parseArguments(["--title", "Work A"]), /message/);
  NodeAssert.throws(() => parseArguments(["--message", "Anything"]), /title/);
});

NodeTest.test(
  "a named-pipe request waits for correlated confirmation of message delivery",
  async () => {
    const address = `\\\\.\\pipe\\t3code-spawn-test-${process.pid}`;
    const server = NodeNet.createServer((socket) => {
      let text = "";
      socket.on("data", (data) => {
        text += data;
        if (!text.includes("\n")) return;
        const command = JSON.parse(text.split("\n")[0]);
        NodeAssert.equal(command.type, "chatgpt.spawn");
        NodeAssert.equal(command.prompt, "Run tests");
        socket.end(
          JSON.stringify({
            version: 1,
            requestId: command.requestId,
            ok: true,
            sessionId: "session-1",
            messageSent: true,
          }) + "\n",
        );
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, resolve);
    });
    try {
      const request = {
        version: 1,
        requestId: "unique-request",
        type: "chatgpt.spawn",
        title: "Test",
        prompt: "Run tests",
      };
      NodeAssert.deepEqual(await sendAppControlRequest(address, request, 2_000), {
        version: 1,
        requestId: request.requestId,
        ok: true,
        sessionId: "session-1",
        messageSent: true,
      });
    } finally {
      server.close();
    }
  },
);

NodeTest.test("mismatched request ids are rejected rather than treated as success", async () => {
  const address = `\\\\.\\pipe\\t3code-spawn-mismatch-${process.pid}`;
  const server = NodeNet.createServer((socket) => {
    socket.once("data", () =>
      socket.end(
        JSON.stringify({
          version: 1,
          requestId: "someone-else",
          ok: true,
          sessionId: "wrong",
          messageSent: true,
        }) + "\n",
      ),
    );
  });
  await new Promise((resolve) => server.listen(address, resolve));
  try {
    await NodeAssert.rejects(
      sendAppControlRequest(address, { version: 1, requestId: "my-request" }, 2_000),
      /Invalid desktop response correlation/,
    );
  } finally {
    server.close();
  }
});
