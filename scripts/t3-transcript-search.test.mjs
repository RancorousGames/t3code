import assert from "node:assert/strict";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readTranscriptSearch, transcriptSearchExpression } from "./t3-transcript-search.mjs";

test("t3_sessions transcript search finds closed conversations, filters and rejects injection", () => {
  const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-mcp-search-"));
  const dbDir = Path.join(home, "userdata");
  Fs.mkdirSync(dbDir);
  const db = new DatabaseSync(Path.join(dbDir, "statev2.sqlite"));
  try {
    db.exec(`
      CREATE TABLE chatgpt_conversations (
        conversation_id TEXT PRIMARY KEY,url TEXT,last_title TEXT,project TEXT,closed_at TEXT
      );
      CREATE TABLE chatgpt_messages (
        id INTEGER PRIMARY KEY,conversation_id TEXT,session_id TEXT,turn_index INTEGER,role TEXT,
        text TEXT,last_seen_at TEXT,revision_hash TEXT
      );
      CREATE VIRTUAL TABLE chatgpt_messages_fts USING fts5(
        text,content='chatgpt_messages',content_rowid='id'
      );
      CREATE TRIGGER chatgpt_messages_index AFTER INSERT ON chatgpt_messages
        BEGIN INSERT INTO chatgpt_messages_fts(rowid,text) VALUES(new.id,new.text); END;
    `);
    const id = "6ae11111-1234-1234-1234-111111111111";
    db.prepare("INSERT INTO chatgpt_conversations VALUES (?,?,?,?,?)").run(
      id, "https://chatgpt.com/c/" + id, "Old tactics", "Altraea", "2026-10-28T10:00:00Z",
    );
    db.prepare("INSERT INTO chatgpt_messages VALUES (?,?,?,?,?,?,?,?)").run(
      1, id, "retired-browser-session", 0, "user", "Cobalt tree fortification idea",
      "2026-10-27T10:00:00Z", "revision",
    );
    const search = (options = {}) => readTranscriptSearch({
      action: "search", query: "Cobalt", ...options,
    }, { home });
    const result = search();
    assert.equal(result.source, "t3-transcript-index");
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].conversationId, id);
    assert.equal(result.results[0].sessionId, "retired-browser-session");
    assert.equal(result.results[0].closedAt, "2026-10-28T10:00:00Z");
    assert.equal(result.results[0].turnIndex, 0);
    assert.equal(search({ includeClosed: false }).results.length, 0);
    assert.equal(search({ role: "assistant" }).results.length, 0);
    assert.equal(search({ project: "Wartribes" }).results.length, 0);
    assert.equal(search({ since: "2026-10-29T00:00:00Z" }).results.length, 0);
    assert.equal(transcriptSearchExpression('Cobalt" OR DELETE FROM chatgpt_messages'), '"Cobalt""" "OR" "DELETE" "FROM" "chatgpt_messages"');
    assert.equal(readTranscriptSearch({ action: "search", query: '"; DROP TABLE x; --' }, { home }).total, 0);
  } finally {
    db.close();
    Fs.rmSync(home, { recursive: true, force: true });
  }
});
