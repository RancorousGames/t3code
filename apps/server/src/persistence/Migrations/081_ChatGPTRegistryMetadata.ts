import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Keep a cumulative, narrow overlay of remote metadata edits. Desktop cache
// accepts only revisions it has not yet applied, never a stale whole-record
// overwrite that could erase a recent local ChatGPT completion or bootstrap.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE chatgpt_session_registry ADD COLUMN metadata_revision INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE chatgpt_session_registry ADD COLUMN metadata_patch_json TEXT NOT NULL DEFAULT '{}'`;
});
