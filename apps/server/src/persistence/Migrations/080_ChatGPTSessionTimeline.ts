import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Server-backed T3 timeline: local browser timestamps are migrated as cache
// data; the server retains last-known values when a guest is hibernated.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE chatgpt_session_registry ADD COLUMN timeline_json TEXT`;
});
