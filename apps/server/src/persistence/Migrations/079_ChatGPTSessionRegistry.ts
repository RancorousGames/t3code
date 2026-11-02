import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Persistent side registry: the desktop driver is the only guest owner.
// Last-known records survive desktop restarts; no guest is ever started by a read.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chatgpt_session_registry (
      environment_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      snapshot_json TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (environment_id, session_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chatgpt_registry_drivers (
      environment_id TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chatgpt_registry_actions (
      request_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      args_json TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      dispatched_at INTEGER,
      result_json TEXT,
      resolved_at INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS chatgpt_registry_actions_driver_pending
    ON chatgpt_registry_actions (environment_id, driver_id, resolved_at, requested_at)
  `;
});
