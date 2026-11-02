import * as Test from "node:test";
import * as Assert from "node:assert/strict";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runRegistryMcpAction } from "./t3-registry-mcp.mjs";

const ENV = "522cb823-71c8-4e9f-b668-dbe1faa9ec55";
const SESSION = "3c88d6c4-57b5-4734-a774-3dcef316f07d";
const PUBLIC = "00000000-0000-4000-8000-000000000098";
const CONVERSATION = "6ae3cf30-a3f4-83ed-b705-41b605ae332a";
const REQUEST = "00000000-0000-4000-8000-000000000111";

Test.test(
  "registry MCP action stores only one guarded request and preserves UNCERTAIN receipt",
  async (t) => {
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-registry-mcp-"));
    t.after(() => Fs.rmSync(home, { recursive: true, force: true }));
    Fs.mkdirSync(Path.join(home, "userdata"));
    Fs.writeFileSync(Path.join(home, "userdata", "environment-id"), ENV);
    const file = Path.join(home, "userdata", "statev2.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`
    CREATE TABLE chatgpt_session_registry (
      environment_id TEXT, session_id TEXT, record_json TEXT, snapshot_json TEXT,
      updated_at INTEGER, timeline_json TEXT, closed_at INTEGER, metadata_revision INTEGER DEFAULT 0,
      metadata_patch_json TEXT DEFAULT '{}', PRIMARY KEY(environment_id,session_id));
    CREATE TABLE chatgpt_registry_drivers (
      environment_id TEXT PRIMARY KEY, driver_id TEXT,last_seen_at INTEGER);
    CREATE TABLE chatgpt_registry_actions (
      request_id TEXT PRIMARY KEY, environment_id TEXT, session_id TEXT,
      driver_id TEXT, action_id TEXT, args_json TEXT, requested_at INTEGER,
      dispatched_at INTEGER, result_json TEXT,resolved_at INTEGER);
  `);
    const record = {
      id: SESSION,
      title: "Agent",
      hidden: false,
      creationOrigin: "manual",
      bootstrapIdentity: { state: "registered", publicId: PUBLIC },
    };
    const snapshot = {
      contentHash: "hash",
      observedAt: Date.now(),
      activity: "idle",
      lastAssistantText: "Previous result",
      conversationId: CONVERSATION,
      url: "https://chatgpt.com/g/g-p-campaign/c/" + CONVERSATION,
    };
    db.prepare(
      "INSERT INTO chatgpt_session_registry(environment_id,session_id,record_json,snapshot_json,updated_at) VALUES(?,?,?,?,?)",
    ).run(ENV, SESSION, JSON.stringify(record), JSON.stringify(snapshot), Date.now());
    db.prepare("INSERT INTO chatgpt_registry_drivers VALUES (?,?,?)").run(
      ENV,
      "desktop",
      Date.now(),
    );
    db.close();

    const input = {
      action: "send",
      sessionId: PUBLIC,
      message: "Please proceed.",
      expectedConversationId: CONVERSATION,
      requestId: REQUEST,
    };
    const queued = await runRegistryMcpAction(input, { home, pollCount: 0 });
    Assert.equal(queued.status, "queued");
    Assert.equal(queued.messageSent, false);
    Assert.equal(queued.requestId, REQUEST);
    Assert.equal(queued.sessionId, PUBLIC);
    const repeat = await runRegistryMcpAction(input, { home, pollCount: 0 });
    Assert.equal(repeat.status, "queued");
    // when_idle is a distinct durable action, not a disguised direct send.
    const idleRequest = "00000000-0000-4000-8000-000000000115";
    const idleQueued = await runRegistryMcpAction(
      { ...input, action: "when_idle", requestId: idleRequest },
      { home, pollCount: 0 },
    );
    Assert.equal(idleQueued.status, "queued");
    Assert.equal(idleQueued.messageSent, false);
    const idleRepeat = await runRegistryMcpAction(
      { ...input, action: "when_idle", requestId: idleRequest },
      { home, pollCount: 0 },
    );
    Assert.equal(idleRepeat.requestId, idleRequest);

    const status = await runRegistryMcpAction(
      { action: "receipt", requestId: REQUEST },
      { home, pollCount: 0 },
    );
    Assert.equal(status.status, "queued");
    const wrong = await runRegistryMcpAction(
      {
        ...input,
        requestId: "00000000-0000-4000-8000-000000000112",
        expectedConversationId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      },
      { home, pollCount: 0 },
    );
    Assert.equal(wrong.ok, false);
    const read = await runRegistryMcpAction(
      { action: "read", sessionId: PUBLIC },
      { home, pollCount: 0 },
    );
    Assert.equal(read.snapshotOnly, true);
    Assert.equal(read.messages.at(-1).text, "Previous result");

    const check = new DatabaseSync(file, { readOnly: true });
    Assert.equal(check.prepare("SELECT count(*) AS n FROM chatgpt_registry_actions").get().n, 3);
    const sent = check
      .prepare("SELECT args_json FROM chatgpt_registry_actions WHERE action_id='send'")
      .get();
    Assert.equal(JSON.parse(sent.args_json).expectedConversationId, CONVERSATION);
    const readRequest = check
      .prepare("SELECT args_json FROM chatgpt_registry_actions WHERE action_id='read'")
      .get();
    Assert.equal(JSON.parse(readRequest.args_json).count, 3);
    check.close();

    // A dead desktop must refuse new mutations without even writing a queue row.
    const staleDriver = new DatabaseSync(file);
    staleDriver.prepare("UPDATE chatgpt_registry_drivers SET last_seen_at=?").run(1);
    staleDriver.close();
    const offline = await runRegistryMcpAction(
      {
        action: "send",
        sessionId: PUBLIC,
        message: "Not delivered",
        expectedConversationId: CONVERSATION,
        requestId: "00000000-0000-4000-8000-000000000114",
      },
      { home, pollCount: 0 },
    );
    Assert.equal(offline.status, "refused");
    Assert.match(offline.reason, /offline/i);
    const staleCheck = new DatabaseSync(file, { readOnly: true });
    Assert.equal(staleCheck.prepare("SELECT count(*) n FROM chatgpt_registry_actions").get().n, 3);
    staleCheck.close();
    const restoredDriver = new DatabaseSync(file);
    restoredDriver.prepare("UPDATE chatgpt_registry_drivers SET last_seen_at=?").run(Date.now());
    restoredDriver.close();

    const driver = new DatabaseSync(file);
    driver
      .prepare(
        "UPDATE chatgpt_registry_actions SET dispatched_at=?, resolved_at=?, result_json=? WHERE request_id=?",
      )
      .run(
        Date.now(),
        Date.now(),
        JSON.stringify({
          ok: true,
          status: "guarded_read_completed",
          verifiedConversationId: CONVERSATION,
          totalTurns: 3,
          messages: [{ role: "assistant", turn: 3, text: "Verified read." }],
        }),
        read.requestId,
      );
    driver.close();
    const observed = await runRegistryMcpAction(
      { action: "receipt", requestId: read.requestId },
      { home },
    );
    Assert.equal(observed.status, "guarded_read_completed");
    Assert.equal(observed.messages[0].text, "Verified read.");
    Assert.equal(observed.verifiedConversationId, CONVERSATION);
    Assert.equal(observed.sessionId, PUBLIC);
    Assert.equal(observed.messageSent, false);

    const closing = new DatabaseSync(file);
    closing
      .prepare("UPDATE chatgpt_session_registry SET closed_at=? WHERE session_id=?")
      .run(Date.now(), SESSION);
    closing.close();
    const closedRead = await runRegistryMcpAction(
      {
        action: "read",
        sessionId: PUBLIC,
      },
      { home, pollCount: 0 },
    );
    Assert.equal(closedRead.snapshotOnly, true);
    const refused = await runRegistryMcpAction(
      {
        action: "send",
        sessionId: PUBLIC,
        requestId: "00000000-0000-4000-8000-000000000113",
        message: "Do not deliver",
        expectedConversationId: CONVERSATION,
      },
      { home, pollCount: 0 },
    );
    Assert.equal(refused.status, "refused");
    const finalDb = new DatabaseSync(file, { readOnly: true });
    Assert.equal(finalDb.prepare("SELECT count(*) AS n FROM chatgpt_registry_actions").get().n, 3);
    finalDb.close();
  },
);
Test.test(
  "unmigrated installation keeps offline snapshot reads but refuses live writes without pipe fallback",
  async (t) => {
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-registry-old-"));
    t.after(() => Fs.rmSync(home, { recursive: true, force: true }));
    Fs.mkdirSync(Path.join(home, "userdata"));
    Fs.writeFileSync(Path.join(home, "userdata", "environment-id"), ENV);
    const file = Path.join(home, "userdata", "statev2.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE chatgpt_session_registry(environment_id TEXT,session_id TEXT,record_json TEXT,snapshot_json TEXT,updated_at INTEGER);
    CREATE TABLE chatgpt_registry_drivers(environment_id TEXT,driver_id TEXT,last_seen_at INTEGER);`);
    db.prepare("INSERT INTO chatgpt_session_registry VALUES(?,?,?,?,?)").run(
      ENV,
      SESSION,
      JSON.stringify({ id: SESSION, title: "Migration pending", hidden: false }),
      JSON.stringify({
        contentHash: "old",
        observedAt: Date.now(),
        activity: "idle",
        lastAssistantText: "Saved answer",
        conversationId: CONVERSATION,
        url: "https://chatgpt.com/c/" + CONVERSATION,
      }),
      Date.now(),
    );
    db.prepare("INSERT INTO chatgpt_registry_drivers VALUES(?,?,?)").run(
      ENV,
      "desktop",
      Date.now(),
    );
    db.close();
    const read = await runRegistryMcpAction({ action: "read", sessionId: SESSION }, { home });
    Assert.equal(read.snapshotOnly, true);
    Assert.equal(read.messages.at(-1).text, "Saved answer");
    const send = await runRegistryMcpAction(
      {
        action: "send",
        sessionId: SESSION,
        message: "Must not be sent",
        expectedConversationId: CONVERSATION,
      },
      { home },
    );
    Assert.equal(send.status, "refused");
    Assert.match(send.reason, /migration/i);
    Assert.equal(
      await runRegistryMcpAction({ action: "receipt", requestId: REQUEST }, { home }).then(
        (v) => v.status,
      ),
      "refused",
    );
    const verify = new DatabaseSync(file, { readOnly: true });
    Assert.equal(
      verify
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='chatgpt_registry_actions'",
        )
        .get(),
      undefined,
    );
    verify.close();
  },
);
