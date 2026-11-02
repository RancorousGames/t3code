import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A desktop removal receipt is a tombstone, not a destructive delete.
// Conversation references and snapshots remain available for history search.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE chatgpt_session_registry ADD COLUMN closed_at INTEGER`;
});
