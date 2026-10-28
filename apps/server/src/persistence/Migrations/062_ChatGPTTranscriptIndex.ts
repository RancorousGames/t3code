import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Indexed by ChatGPT conversation identity, never the ephemeral T3 browser-session ID.
// This schema is dormant until T3-0104 supplies snapshots/full reads to the server.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chatgpt_conversations (
      conversation_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      last_title TEXT,
      project TEXT,
      last_session_id TEXT,
      last_seen_at TEXT NOT NULL,
      closed_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chatgpt_messages (
      id INTEGER PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES chatgpt_conversations(conversation_id),
      session_id TEXT NOT NULL,
      turn_key TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revision_hash TEXT NOT NULL,
      possibly_truncated INTEGER NOT NULL DEFAULT 0,
      UNIQUE (conversation_id, turn_key, role, ordinal)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS chatgpt_messages_conversation_order
    ON chatgpt_messages (conversation_id, turn_index, role, ordinal)
  `;
  // External-content FTS avoids storing message text twice. Triggers keep the index
  // synchronized for later ingest/revision changes without a separate rebuild pass.
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS chatgpt_messages_fts
    USING fts5(text, content='chatgpt_messages', content_rowid='id')
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS chatgpt_messages_fts_insert
    AFTER INSERT ON chatgpt_messages BEGIN
      INSERT INTO chatgpt_messages_fts(rowid, text) VALUES (new.id, new.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS chatgpt_messages_fts_delete
    AFTER DELETE ON chatgpt_messages BEGIN
      INSERT INTO chatgpt_messages_fts(chatgpt_messages_fts, rowid, text)
      VALUES ('delete', old.id, old.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS chatgpt_messages_fts_update
    AFTER UPDATE OF text ON chatgpt_messages
    WHEN old.text <> new.text BEGIN
      INSERT INTO chatgpt_messages_fts(chatgpt_messages_fts, rowid, text)
      VALUES ('delete', old.id, old.text);
      INSERT INTO chatgpt_messages_fts(rowid, text) VALUES (new.id, new.text);
    END
  `;
});
