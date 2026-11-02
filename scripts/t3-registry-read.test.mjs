import * as NodeTest from "node:test";
import * as Assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { readRegistryList, readRegistryChildren } from "./t3-registry-read.mjs";

const ID = "3c88d6c4-57b5-4734-a774-3dcef316f07d";
const ENV = "522cb823-71c8-4e9f-b668-dbe1faa9ec55";
const PUBLIC_ID = "00000000-0000-4000-8000-000000000099";
const CONVERSATION = "6ae3cf30-a3f4-83ed-b705-41b605ae332a";

NodeTest.test(
  "t3_sessions registry list survives missing renderer, shows stale and respects hidden",
  (t) => {
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-registry-read-"));
    t.after(() => Fs.rmSync(home, { recursive: true, force: true }));
    const userdata = Path.join(home, "userdata");
    Fs.mkdirSync(userdata);
    Fs.writeFileSync(Path.join(userdata, "environment-id"), ENV);
    const db = new DatabaseSync(Path.join(userdata, "statev2.sqlite"));
    db.exec(
      "CREATE TABLE chatgpt_registry_drivers(environment_id TEXT,driver_id TEXT,last_seen_at INTEGER);",
    );
    db.exec(
      "CREATE TABLE chatgpt_session_registry(environment_id TEXT,session_id TEXT,record_json TEXT,snapshot_json TEXT,updated_at INTEGER,closed_at INTEGER);",
    );
    const insert = db.prepare("INSERT INTO chatgpt_session_registry VALUES(?,?,?,?,?,?)");
    const snapshot = {
      conversationId: CONVERSATION,
      url: `https://chatgpt.com/g/g-p-project_2/c/${CONVERSATION}`,
      contentHash: "hash",
      turnCount: 3,
      activity: "idle",
      observedAt: 2,
      lastAssistantText: "Done.",
      lastUserText: "Ship it.",
    };
    const record = {
      id: ID,
      title: "Task agent",
      hidden: false,
      project: "t3code",
      creationOrigin: "manual",
      bootstrapIdentity: { state: "registered", publicId: PUBLIC_ID },
    };
    insert.run(ENV, ID, JSON.stringify(record), JSON.stringify(snapshot), 200, null);
    insert.run(
      ENV,
      "dd02ce72-a974-48b2-929b-4b222d33b433",
      JSON.stringify({ id: "dd02ce72-a974-48b2-929b-4b222d33b433", hidden: true }),
      "null",
      100,
      null,
    );
    insert.run(
      ENV,
      "dd02ce72-a974-48b2-929b-4b222d33b434",
      JSON.stringify({
        id: "dd02ce72-a974-48b2-929b-4b222d33b434",
        creationOrigin: "manual",
        bootstrapIdentity: { state: "awaiting_marker" },
      }),
      "null",
      99,
      null,
    );
    insert.run(
      ENV,
      "dd02ce72-a974-48b2-929b-4b222d33b435",
      JSON.stringify({ id: "dd02ce72-a974-48b2-929b-4b222d33b435" }),
      "null",
      98,
      10,
    );
    db.prepare("INSERT INTO chatgpt_registry_drivers VALUES (?,?,?)").run(ENV, "desktop", 1000);
    db.close();

    const current = readRegistryList({ action: "list", which: "all" }, { home, now: 1001 });
    Assert.equal(current.driverOnline, true);
    Assert.equal(current.total, 1);
    Assert.equal(current.sessions[0].id, PUBLIC_ID);
    Assert.equal(current.sessions[0].browserSessionId, ID);
    Assert.equal(current.sessions[0].publicSessionId, PUBLIC_ID);
    Assert.equal(current.sessions[0].conversationId, CONVERSATION);
    Assert.equal(current.sessions[0].lastText, "Done.");
    const stale = readRegistryList(
      { action: "list", which: "all", includeHidden: true },
      { home, now: 20000 },
    );
    Assert.equal(stale.driverOnline, false);
    Assert.equal(stale.total, 2);
    Assert.ok(stale.sessions.every((s) => s.stale && s.status === "driver_offline"));
    Assert.match(stale.sessions[0].statusReason, /No request was queued/);
    const withMismatchedUrl = {
      ...snapshot,
      url: "https://chatgpt.com/c/ffffffff-ffff-ffff-ffff-ffffffffffff",
    };
    const changed = new DatabaseSync(Path.join(userdata, "statev2.sqlite"));
    changed
      .prepare("UPDATE chatgpt_session_registry SET snapshot_json=? WHERE session_id=?")
      .run(JSON.stringify(withMismatchedUrl), ID);
    changed.close();
    Assert.equal(
      readRegistryList({ action: "list" }, { home, now: 1001 }).sessions[0].conversationId,
      null,
    );
    const childId = "dd02ce72-a974-48b2-929b-4b222d33b438";
    const child = new DatabaseSync(Path.join(userdata, "statev2.sqlite"));
    child.prepare("INSERT INTO chatgpt_session_registry VALUES(?,?,?,?,?,?)").run(
      ENV,
      childId,
      JSON.stringify({
        id: childId,
        title: "Child worker",
        project: "Wartribes",
        parentSessionId: ID,
        hidden: true,
        creationOrigin: "backend",
        spawnRequestId: "request-1",
        bootstrapIdentity: { publicId: childId, state: "registered" },
        binding: { taskRef: { board: "Wartribes", id: "WT-0218" } },
      }),
      JSON.stringify({ activity: "working", lastAssistantText: "Private child response" }),
      700,
      null,
    );
    child.close();
    const byPublic = readRegistryChildren(
      { action: "children", sessionId: PUBLIC_ID },
      { home, now: 1001 },
    );
    Assert.equal(byPublic.total, 1);
    Assert.equal(byPublic.children[0].sessionId, childId);
    Assert.equal(byPublic.children[0].activity, "working");
    Assert.equal(byPublic.children[0].secondsSinceUpdate, 0); // observed timestamps are Unix milliseconds
    Assert.equal(byPublic.children[0].activeTask, "WT-0218");
    Assert.equal(byPublic.children[0].hidden, true);
    Assert.equal("lastText" in byPublic.children[0], false);
    Assert.deepEqual(
      readRegistryChildren({ action: "children", sessionId: ID }, { home, now: 1001 }).children,
      byPublic.children,
    );
    Assert.throws(() => readRegistryChildren({ action: "children", sessionId: "not-an-id" }, { home }), /sessionId UUID/);
  },
);
