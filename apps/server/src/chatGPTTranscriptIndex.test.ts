// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as Index from "./chatGPTTranscriptIndex.ts";

const indexLayer = Index.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const url = "https://chatgpt.com/c/6ae11111-1234-1234-1234-111111111111";
const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 11, minute)).toISOString();

it.effect("indexes by conversation, deduplicates revisions, and keeps FTS synced on edits and closure", () =>
  Effect.gen(function* () {
    const index = yield* Index.ChatGPTTranscriptIndex;
    const sql = yield* SqlClient.SqlClient;
    const message = {
      conversationUrl: url, sessionId: "t3-session-A", observedAt: at(0),
      turn: 0, turnKey: "turn-0", index: 0, role: "user" as const,
      text: "Skyroot enables extra wood", title: "Wonder tactics", project: "Altraea",
    };
    assert.equal(yield* index.ingest(message), "inserted");
    assert.equal(yield* index.ingest(message), "deduplicated");
    assert.equal((yield* index.search({ query: "Skyroot" })).length, 1);

    assert.equal(yield* index.ingest({ ...message, observedAt: at(1), sessionId: "t3-session-B" }), "deduplicated");
    assert.equal(yield* index.ingest({
      ...message, observedAt: at(2), sessionId: "t3-session-B", text: "The Hollow Crown yields gold",
    }), "revised");
    assert.equal((yield* index.search({ query: "Skyroot" })).length, 0);
    const [hit] = yield* index.search({ query: "Hollow Crown", phrase: true });
    assert.equal(hit?.sessionId, "t3-session-B");
    assert.equal(hit?.title, "Wonder tactics");
    assert.equal(hit?.project, "Altraea");
    assert.equal(hit?.firstTurnMissing, false);
    assert.equal((yield* index.search({ query: "Hollow", role: "assistant" })).length, 0);
    assert.equal((yield* index.search({ query: "Hollow", project: "Another" })).length, 0);

    // A late import from another session must not overwrite the newest revision.
    assert.equal(yield* index.ingest({ ...message, observedAt: at(0) }), "ignored");
    assert.equal((yield* index.search({ query: "Skyroot" })).length, 0);
    assert.equal((yield* index.search({ query: "Hollow" })).length, 1);

    // Closing/hiding a T3 session must never cascade-delete its conversation.
    yield* sql`UPDATE chatgpt_conversations SET closed_at = ${at(3)} WHERE conversation_id = ${hit?.conversationId}`;
    assert.equal((yield* index.search({ query: "Hollow" })).length, 1);
    const rows = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM chatgpt_messages`;
    assert.equal(rows[0]?.n, 1);

    yield* index.ingest({ ...message, conversationUrl: "https://chatgpt.com/c/partial-history",
      turn: 7, turnKey: "turn-7", text: "An unobserved opening", observedAt: at(4) });
    const [partial] = yield* index.search({ query: "unobserved" });
    assert.equal(partial?.firstTurnMissing, true);
    assert.deepEqual(yield* index.search({ query: " \" " }), []);
  }).pipe(Effect.provide(indexLayer)),
);

it.effect("backfills copied real archive JSONL idempotently without reading or changing live SQLite", () => {
  const source = Path.resolve(import.meta.dirname, "../../../.t3/userdata/chatgpt-browser-archive");
  const scratch = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-transcript-index-"));
  const copy = Path.join(scratch, "archive");
  Fs.cpSync(source, copy, { recursive: true });
  return Effect.gen(function* () {
    const index = yield* Index.ChatGPTTranscriptIndex;
    const sql = yield* SqlClient.SqlClient;
    const initial = yield* index.backfillArchive(copy);
    assert.isAbove(initial.files, 0);
    assert.isAbove(initial.inserted, 0);
    const count = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM chatgpt_messages`;
    assert.isAbove(count[0]?.n ?? 0, 0);
    const again = yield* index.backfillArchive(copy);
    assert.equal(again.inserted, 0);
    assert.equal(again.revised, 0);
    const recount = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM chatgpt_messages`;
    assert.equal(recount[0]?.n, count[0]?.n);
    const indexed = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM chatgpt_messages_fts`;
    assert.equal(indexed[0]?.n, count[0]?.n);
  }).pipe(
    Effect.provide(indexLayer),
    Effect.ensuring(Effect.sync(() => Fs.rmSync(scratch, { recursive: true, force: true }))),
  );
});
