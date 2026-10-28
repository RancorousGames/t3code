// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off tryCatchInEffectGen:off
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

const MAX_TEXT = 24_000;

export interface ChatGPTTranscriptTurn {
  readonly conversationUrl: string;
  readonly sessionId: string;
  readonly observedAt: string;
  readonly role: "user" | "assistant";
  readonly turn: number;
  readonly turnKey?: string | null;
  readonly index: number;
  readonly text: string;
  readonly possiblyTruncated?: boolean;
  readonly title?: string | null;
  readonly project?: string | null;
}

export interface ChatGPTTranscriptHit {
  readonly conversationId: string;
  readonly url: string;
  readonly title: string | null;
  readonly project: string | null;
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly role: "user" | "assistant";
  readonly snippet: string;
  readonly observedAt: string;
  readonly revisionHash: string;
  /** True means the first turn was not observed. False does not guarantee complete DOM history. */
  readonly firstTurnMissing: boolean;
}

type IngestResult = "inserted" | "revised" | "deduplicated" | "ignored";
export interface ChatGPTArchiveBackfillResult {
  readonly files: number;
  readonly records: number;
  readonly inserted: number;
  readonly revised: number;
  readonly deduplicated: number;
  readonly ignored: number;
  readonly malformedLines: number;
}

function conversationFromUrl(url: string) {
  const match = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/c\/([a-z0-9-]+)(?:[/?#]|$)/i.exec(url);
  return match ? { id: match[1]!.toLowerCase(), url: url.split(/[?#]/, 1)[0]! } : null;
}

const timestamp = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** Convert free-text search to an FTS MATCH expression, never SQL syntax. */
function ftsExpression(query: string, phrase: boolean): string | null {
  const words = query.trim().split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).slice(0, 12);
  if (!words.length) return null;
  const quote = (word: string) => '"' + word.replaceAll('"', '""') + '"';
  return phrase ? quote(words.join(" ")) : words.map(quote).join(" ");
}

export class ChatGPTTranscriptIndex extends Context.Service<
  ChatGPTTranscriptIndex,
  {
    readonly ingest: (turn: ChatGPTTranscriptTurn) => Effect.Effect<IngestResult, SqlError.SqlError>;
    readonly backfillArchive: (directory: string) => Effect.Effect<ChatGPTArchiveBackfillResult, SqlError.SqlError>;
    readonly search: (input: {
      readonly query: string;
      readonly phrase?: boolean;
      readonly role?: "user" | "assistant";
      readonly project?: string;
      readonly limit?: number;
    }) => Effect.Effect<readonly ChatGPTTranscriptHit[], SqlError.SqlError>;
  }
>()("t3/chatGPTTranscriptIndex") {}

// No desktop probing or live-backfill at construction time. The service can be
// wired after T3-0104 provides the snapshot/change feed.
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const ingest = Effect.fn("ChatGPTTranscriptIndex.ingest")(function* (turn: ChatGPTTranscriptTurn) {
    const conversation = conversationFromUrl(turn.conversationUrl);
    const observedAt = timestamp(turn.observedAt);
    if (
      !conversation ||
      !observedAt ||
      !turn.sessionId ||
      !["user", "assistant"].includes(turn.role) ||
      !Number.isSafeInteger(turn.turn) || turn.turn < 0 ||
      !Number.isSafeInteger(turn.index) || turn.index < 0 ||
      typeof turn.text !== "string"
    ) return "ignored" as const;

    const text = turn.text.slice(0, MAX_TEXT);
    const revisionHash = Crypto.createHash("sha256").update(text).digest("hex");
    const turnKey = turn.turnKey && turn.turnKey.length <= 200
      ? "key:" + turn.turnKey : "turn:" + turn.turn;

    return yield* sql.withTransaction(Effect.gen(function* () {
      yield* sql`
        INSERT INTO chatgpt_conversations
          (conversation_id, url, last_title, project, last_session_id, last_seen_at)
        VALUES (
          ${conversation.id}, ${conversation.url},
          ${turn.title ?? null}, ${turn.project ?? null}, ${turn.sessionId}, ${observedAt}
        )
        ON CONFLICT(conversation_id) DO UPDATE SET
          url = excluded.url,
          last_title = COALESCE(excluded.last_title, chatgpt_conversations.last_title),
          project = COALESCE(excluded.project, chatgpt_conversations.project),
          last_session_id = excluded.last_session_id,
          last_seen_at = excluded.last_seen_at
        WHERE excluded.last_seen_at >= chatgpt_conversations.last_seen_at
      `;
      const existing = yield* sql<{ readonly revision_hash: string; readonly last_seen_at: string }>`
        SELECT revision_hash, last_seen_at FROM chatgpt_messages
        WHERE conversation_id = ${conversation.id} AND turn_key = ${turnKey}
          AND role = ${turn.role} AND ordinal = ${turn.index}
      `;
      yield* sql`
        INSERT INTO chatgpt_messages (
          conversation_id, session_id, turn_key, turn_index, role, ordinal,
          text, first_seen_at, last_seen_at, revision_hash, possibly_truncated
        ) VALUES (
          ${conversation.id}, ${turn.sessionId}, ${turnKey}, ${turn.turn},
          ${turn.role}, ${turn.index}, ${text}, ${observedAt}, ${observedAt},
          ${revisionHash}, ${turn.possiblyTruncated || turn.text.length >= MAX_TEXT ? 1 : 0}
        )
        ON CONFLICT(conversation_id, turn_key, role, ordinal) DO UPDATE SET
          text = CASE WHEN excluded.last_seen_at >= chatgpt_messages.last_seen_at
                      THEN excluded.text ELSE chatgpt_messages.text END,
          revision_hash = CASE WHEN excluded.last_seen_at >= chatgpt_messages.last_seen_at
                               THEN excluded.revision_hash ELSE chatgpt_messages.revision_hash END,
          session_id = CASE WHEN excluded.last_seen_at >= chatgpt_messages.last_seen_at
                            THEN excluded.session_id ELSE chatgpt_messages.session_id END,
          turn_index = CASE WHEN excluded.last_seen_at >= chatgpt_messages.last_seen_at
                            THEN excluded.turn_index ELSE chatgpt_messages.turn_index END,
          possibly_truncated = CASE WHEN excluded.last_seen_at >= chatgpt_messages.last_seen_at
                                    THEN excluded.possibly_truncated ELSE chatgpt_messages.possibly_truncated END,
          first_seen_at = MIN(chatgpt_messages.first_seen_at, excluded.first_seen_at),
          last_seen_at = MAX(chatgpt_messages.last_seen_at, excluded.last_seen_at)
        WHERE excluded.last_seen_at > chatgpt_messages.last_seen_at
           OR excluded.first_seen_at < chatgpt_messages.first_seen_at
           OR (excluded.last_seen_at = chatgpt_messages.last_seen_at
               AND excluded.revision_hash <> chatgpt_messages.revision_hash)
      `;
      if (!existing.length) return "inserted" as const;
      if (existing[0]!.revision_hash === revisionHash) return "deduplicated" as const;
      return observedAt >= existing[0]!.last_seen_at ? "revised" as const : "ignored" as const;
    }));
  });

  const backfillArchive = Effect.fn("ChatGPTTranscriptIndex.backfillArchive")(function* (
    directory: string,
  ) {
    const entries = yield* Effect.promise(() =>
      Fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }),
    );
    const stats = {
      files: 0, records: 0, inserted: 0, revised: 0,
      deduplicated: 0, ignored: 0, malformedLines: 0,
    };
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      stats.files++;
      const body = yield* Effect.promise(() => Fs.readFile(Path.join(directory, entry.name), "utf8"));
      let metadata: { readonly title?: string | null; readonly project?: string | null } = {};
      for (const line of body.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          stats.malformedLines++;
          continue;
        }
        if (record.version !== 1) continue;
        if (record.event === "session-metadata") {
          metadata = {
            title: typeof record.title === "string" ? record.title : null,
            project: typeof record.project === "string" ? record.project : null,
          };
          continue;
        }
        stats.records++;
        if (
          typeof record.conversationUrl !== "string" ||
          typeof record.sessionId !== "string" ||
          typeof record.observedAt !== "string" ||
          (record.role !== "user" && record.role !== "assistant") ||
          typeof record.turn !== "number" ||
          typeof record.index !== "number" ||
          typeof record.text !== "string"
        ) {
          stats.ignored++;
          continue;
        }
        const result = yield* ingest({
          conversationUrl: record.conversationUrl,
          sessionId: record.sessionId,
          observedAt: record.observedAt,
          role: record.role,
          turn: record.turn,
          turnKey: typeof record.turnKey === "string" ? record.turnKey : null,
          index: record.index,
          text: record.text,
          possiblyTruncated: record.possiblyTruncated === true,
          ...metadata,
        });
        stats[result]++;
      }
    }
    return stats;
  });

  const search = Effect.fn("ChatGPTTranscriptIndex.search")(function* (input: {
    readonly query: string;
    readonly phrase?: boolean;
    readonly role?: "user" | "assistant";
    readonly project?: string;
    readonly limit?: number;
  }) {
    const expression = ftsExpression(input.query, input.phrase === true);
    if (!expression) return [] as ChatGPTTranscriptHit[];
    const limit = Number.isFinite(input.limit)
      ? Math.max(1, Math.min(100, Math.floor(input.limit!))) : 20;
    const rows = yield* sql<{
      readonly conversation_id: string; readonly url: string;
      readonly last_title: string | null; readonly project: string | null;
      readonly session_id: string; readonly turn_index: number;
      readonly role: "user" | "assistant"; readonly snippet: string;
      readonly last_seen_at: string; readonly revision_hash: string;
      readonly first_turn_missing: number;
    }>`
      SELECT m.conversation_id, c.url, c.last_title, c.project,
             m.session_id, m.turn_index, m.role,
             snippet(chatgpt_messages_fts, 0, '[', ']', '…', 14) AS snippet,
             m.last_seen_at, m.revision_hash,
             NOT EXISTS (
               SELECT 1 FROM chatgpt_messages first
               WHERE first.conversation_id = m.conversation_id AND first.turn_index = 0
             ) AS first_turn_missing
      FROM chatgpt_messages_fts
      JOIN chatgpt_messages m ON m.id = chatgpt_messages_fts.rowid
      JOIN chatgpt_conversations c ON c.conversation_id = m.conversation_id
      WHERE chatgpt_messages_fts MATCH ${expression}
        AND (${input.role ?? null} IS NULL OR m.role = ${input.role ?? null})
        AND (${input.project ?? null} IS NULL OR c.project = ${input.project ?? null})
      ORDER BY bm25(chatgpt_messages_fts), m.last_seen_at DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      url: row.url,
      title: row.last_title,
      project: row.project,
      sessionId: row.session_id,
      turnIndex: row.turn_index,
      role: row.role,
      snippet: row.snippet,
      observedAt: row.last_seen_at,
      revisionHash: row.revision_hash,
      firstTurnMissing: Boolean(row.first_turn_missing),
    }));
  });

  return { ingest, backfillArchive, search };
});

export const layer = Layer.effect(ChatGPTTranscriptIndex, make);
