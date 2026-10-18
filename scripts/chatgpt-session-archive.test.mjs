import { test } from "node:test";
import assert from "node:assert/strict";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";
import {
  archiveOnce,
  archiveSession,
  computeRevisions,
  readArchivedSession,
} from "./chatgpt-session-archive.mjs";

test("writes revisions only when visible messages change", async (t) => {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-chatgpt-archive-test-"));
  t.after(() => Fs.rmSync(root, { recursive: true, force: true }));
  let response = {
    url: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    messages: [
      { role: "user", turn: 0, text: "How are you?" },
      { role: "assistant", turn: 0, text: "Starting" },
    ],
  };
  const client = async (input) => {
    assert.equal(input.action, "read");
    assert.equal(input.count, 20);
    return response;
  };
  const session = { id: "session-1", title: "Example", project: "Example" };
  assert.equal((await archiveSession(session, { directory: root, exchange: client })).captured, 2);
  assert.equal((await archiveSession(session, { directory: root, exchange: client })).captured, 0);
  response = {
    ...response,
    messages: [response.messages[0], { role: "assistant", turn: 0, text: "Finished" }],
  };
  assert.equal((await archiveSession(session, { directory: root, exchange: client })).captured, 1);
  const files = Fs.readdirSync(root).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const rows = Fs.readFileSync(Path.join(root, files[0]), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(rows.filter((item) => item.role === "assistant").length, 2);
  assert.equal(rows.at(-1).text, "Finished");
  assert.equal(rows[0].title, "Example");
  const reconstructed = readArchivedSession("session-1", { directory: root });
  assert.equal(reconstructed.revisions, 3);
  assert.equal(reconstructed.messages.length, 2);
  assert.equal(
    reconstructed.messages.find((message) => message.role === "assistant").text,
    "Finished",
  );
  assert.equal(readArchivedSession("not-present", { directory: root }).messages.length, 0);
});

test("stable DOM turn keys survive virtualized position changes", () => {
  const base = {
    url: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    sessionId: "session-a",
  };
  const first = computeRevisions(
    {},
    {
      ...base,
      messages: [{ role: "assistant", turn: 0, turnKey: "stable-turn-1", text: "hello" }],
    },
  );
  assert.equal(first.records.length, 1);
  const shifted = computeRevisions(first.hashes, {
    ...base,
    messages: [{ role: "assistant", turn: 10, turnKey: "stable-turn-1", text: "hello" }],
  });
  assert.equal(shifted.records.length, 0);
  const revised = computeRevisions(shifted.hashes, {
    ...base,
    messages: [{ role: "assistant", turn: 10, turnKey: "stable-turn-1", text: "hello updated" }],
  });
  assert.equal(revised.records.length, 1);
});

test("never archives unavailable URLs, unmounted messages, or hidden sessions", async (t) => {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-chatgpt-archive-test-"));
  t.after(() => Fs.rmSync(root, { recursive: true, force: true }));
  const skipped = computeRevisions(
    {},
    {
      sessionId: "session-1",
      url: "https://example.com/",
      messages: [{ role: "assistant", turn: 0, text: "Not a ChatGPT page" }],
    },
  );
  assert.equal(skipped.records.length, 0);
  assert.equal(
    (
      await archiveSession(
        { id: "hidden", hidden: true },
        {
          directory: root,
          exchange: () => {
            throw new Error("should not read hidden session");
          },
        },
      )
    ).captured,
    0,
  );
  assert.equal(Fs.readdirSync(root).length, 0);
});

test("scans all nonhidden browser sessions without sending messages", async (t) => {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-chatgpt-archive-test-"));
  t.after(() => Fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const exchange = async (input) => {
    calls.push(input);
    if (input.action === "list")
      return {
        sessions: [
          { id: "active", title: "worker", status: "working", hidden: false },
          { id: "hidden", title: "secret", hidden: true },
        ],
      };
    return {
      url: "https://chatgpt.com/c/11111111-1111-1111-1111-111111111111",
      messages: [{ role: "assistant", turn: 0, text: "A message" }],
    };
  };
  const result = await archiveOnce({ directory: root, exchange });
  assert.deepEqual(result, { sessions: 1, captured: 1, failures: 0 });
  assert.deepEqual(
    calls.map((call) => call.action),
    ["list", "read"],
  );
  assert.equal(calls[1].sessionId, "active");
});
