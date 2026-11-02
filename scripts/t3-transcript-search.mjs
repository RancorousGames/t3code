#!/usr/bin/env node
/**
 * Read-only MCP search of T3's server-side ChatGPT transcript FTS index.
 * The server owns writes and migrations. Searching never mounts a guest,
 * restores a session, or changes the database.
 */
import { DatabaseSync } from "node:sqlite";
import * as Fs from "node:fs";
import * as Path from "node:path";
import * as URL from "node:url";

const ROOT = Path.resolve(Path.dirname(URL.fileURLToPath(import.meta.url)), "..");
const DEFAULT_HOME = Path.join(ROOT, ".t3");

export function transcriptSearchExpression(query, phrase = false) {
  const words = query.trim().split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).slice(0, 12);
  if (!words.length) return null;
  const quote = (word) => '"' + word.replaceAll('"', '""') + '"';
  return phrase ? quote(words.join(" ")) : words.map(quote).join(" ");
}

export function readTranscriptSearch(input, { home = DEFAULT_HOME } = {}) {
  if (!input || input.action !== "search" ||
      typeof input.query !== "string" || !input.query.trim() || input.query.length > 400)
    throw new Error("search requires a nonempty query of at most 400 characters.");
  if (input.role !== undefined && !["user", "assistant"].includes(input.role))
    throw new Error("role must be user or assistant.");
  if (input.project !== undefined &&
      (typeof input.project !== "string" || !input.project.trim() || input.project.length > 160))
    throw new Error("project must be a nonempty project name <= 160 characters.");
  if (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100))
    throw new Error("limit must be 1..100.");
  if (input.phrase !== undefined && typeof input.phrase !== "boolean")
    throw new Error("phrase must be boolean.");
  if (input.includeClosed !== undefined && typeof input.includeClosed !== "boolean")
    throw new Error("includeClosed must be boolean.");
  if (input.since !== undefined &&
      (typeof input.since !== "string" || !Number.isFinite(Date.parse(input.since))))
    throw new Error("since must be an ISO timestamp.");
  const extra = Object.keys(input).filter((key) =>
    !["action", "query", "role", "project", "limit", "phrase", "includeClosed", "since"].includes(key));
  if (extra.length) throw new Error("Unknown transcript-search fields: " + extra.join(", "));

  const expression = transcriptSearchExpression(input.query, input.phrase);
  const dbPath = Path.join(home, "userdata", "statev2.sqlite");
  if (!Fs.existsSync(dbPath))
    throw new Error("T3 transcript index unavailable: server database is missing.");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('chatgpt_conversations','chatgpt_messages','chatgpt_messages_fts')",
    ).all();
    if (tables.length !== 3)
      throw new Error("T3 transcript index unavailable: migration 062 has not been deployed.");
    if (!expression)
      return { action: "search", source: "t3-transcript-index", results: [], total: 0 };
    const role = input.role ?? null;
    const project = input.project ?? null;
    const closed = input.includeClosed === false ? 0 : 1;
    const since = input.since ? new Date(input.since).toISOString() : null;
    const rows = db.prepare(`
      SELECT m.conversation_id, c.url, c.last_title, c.project, c.closed_at,
             m.session_id, m.turn_index, m.role,
             snippet(chatgpt_messages_fts, 0, '[', ']', '…', 14) AS snippet,
             m.last_seen_at, m.revision_hash,
             NOT EXISTS (
               SELECT 1 FROM chatgpt_messages first
               WHERE first.conversation_id=m.conversation_id AND first.turn_index=0
             ) AS first_turn_missing
      FROM chatgpt_messages_fts
      JOIN chatgpt_messages m ON m.id=chatgpt_messages_fts.rowid
      JOIN chatgpt_conversations c ON c.conversation_id=m.conversation_id
      WHERE chatgpt_messages_fts MATCH ?
        AND (? IS NULL OR m.role=?)
        AND (? IS NULL OR c.project=?)
        AND (?=1 OR c.closed_at IS NULL)
        AND (? IS NULL OR m.last_seen_at>=?)
      ORDER BY bm25(chatgpt_messages_fts), CASE WHEN m.role='user' THEN 0 ELSE 1 END,
               m.last_seen_at DESC
      LIMIT ?
    `).all(expression, role, role, project, project, closed, since, since, input.limit ?? 20);
    const results = rows.map((row) => ({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      url: row.url,
      title: row.last_title,
      project: row.project,
      closedAt: row.closed_at,
      turnIndex: row.turn_index,
      role: row.role,
      snippet: row.snippet,
      observedAt: row.last_seen_at,
      revisionHash: row.revision_hash,
      firstTurnMissing: Boolean(row.first_turn_missing),
    }));
    return { action: "search", source: "t3-transcript-index", results, total: results.length };
  } finally {
    db.close();
  }
}

if (process.argv[1] && Path.resolve(process.argv[1]) === URL.fileURLToPath(import.meta.url)) {
  try {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 8_192) throw new Error("Transcript search request exceeds 8 KiB.");
    }
    process.stdout.write(JSON.stringify(readTranscriptSearch(JSON.parse(input.replace(/^\uFEFF/, "")))) + "\n");
  } catch (error) {
    process.stderr.write(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
