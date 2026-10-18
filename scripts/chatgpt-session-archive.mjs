#!/usr/bin/env node
/**
 * Incrementally archive rendered ChatGPT messages through T3 desktop's
 * named-pipe controller. Read-only; no private ChatGPT API or cookies.
 * Append-only revision log; DOM virtualization and bounded message reads
 * mean that this is best-effort, not a complete transcript guarantee.
 */
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";
import * as URL from "node:url";
import { controlSessions } from "./chatgpt-sessions.mjs";

// Match the custom desktop bridge home used by scripts/chatgpt-sessions.mjs.
// Do not read/write the older ~/.t3/userdata tree when this checkout owns sessions.
export const DEFAULT_ARCHIVE_DIR = Path.resolve(
  import.meta.dirname,
  "../.t3/userdata/chatgpt-browser-archive",
);
const MAX_SESSIONS_PER_SCAN = 100;
const MAX_MESSAGES_PER_READ = 20;
const MAX_MESSAGE_TEXT = 24_000;

const hash = (value) => Crypto.createHash("sha256").update(value).digest("hex");

function safeSessionFile(sessionId) {
  if (typeof sessionId !== "string" || !sessionId.length || sessionId.length > 512)
    throw new Error("Invalid session ID");
  return hash(sessionId).slice(0, 32);
}

function loadIndex(file) {
  try {
    const value = JSON.parse(Fs.readFileSync(file, "utf8"));
    if (
      value &&
      value.version === 1 &&
      value.hashes &&
      typeof value.hashes === "object" &&
      !Array.isArray(value.hashes)
    )
      return value.hashes;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {};
}

function saveIndex(file, hashes) {
  const temp = file + "." + process.pid + ".tmp";
  try {
    Fs.writeFileSync(temp, JSON.stringify({ version: 1, hashes }), { flag: "wx", mode: 0o600 });
    Fs.renameSync(temp, file);
  } finally {
    if (Fs.existsSync(temp)) Fs.unlinkSync(temp);
  }
}

/** Changed partial/final messages become immutable append-only revisions. */
export function computeRevisions(previous, input) {
  const next = { ...previous };
  const records = [];
  const url =
    typeof input.url === "string" &&
    /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/c\/[a-z0-9-]+/i.test(input.url)
      ? input.url.split("?")[0]
      : null;
  if (!url) return { hashes: next, records };
  const seen = new Map();
  for (const m of Array.isArray(input.messages) ? input.messages : []) {
    if (
      !m ||
      !["user", "assistant"].includes(m.role) ||
      typeof m.text !== "string" ||
      !Number.isSafeInteger(m.turn) ||
      m.turn < 0
    )
      continue;
    const ordinal = String(m.turn) + ":" + m.role;
    const index = seen.get(ordinal) ?? 0;
    seen.set(ordinal, index + 1);
    const turnKey =
      typeof m.turnKey === "string" && m.turnKey.length > 0 && m.turnKey.length <= 200
        ? m.turnKey
        : null;
    const key = url + "|" + (turnKey ?? m.turn) + "|" + m.role + "|" + index;
    const text = m.text.slice(0, MAX_MESSAGE_TEXT);
    const fingerprint = hash(text);
    if (next[key] === fingerprint) continue;
    records.push({
      version: 1,
      sessionId: input.sessionId,
      conversationUrl: url,
      observedAt: input.observedAt ?? new Date().toISOString(),
      role: m.role,
      turn: m.turn,
      turnKey,
      index,
      text,
      possiblyTruncated: m.text.length >= MAX_MESSAGE_TEXT,
      source: "t3-rendered-chatgpt-dom",
    });
    next[key] = fingerprint;
  }
  return { hashes: next, records };
}

export async function archiveSession(session, options = {}) {
  const directory = options.directory ?? DEFAULT_ARCHIVE_DIR;
  const exchange = options.exchange ?? controlSessions;
  if (!session || typeof session.id !== "string" || session.hidden === true)
    return { captured: 0, readable: false };
  const response = await exchange({
    action: "read",
    sessionId: session.id,
    from: "end",
    count: MAX_MESSAGES_PER_READ,
    maxMessageChars: MAX_MESSAGE_TEXT,
  });
  // T3 wraps reads in {session, selection}; a flat page response is not its API.
  const data = response?.session;
  if (!data || !Array.isArray(data.messages) || typeof data.url !== "string")
    throw new Error("Unexpected T3 read response: expected {session:{url,messages}}");
  if (!data.messages.length) return { captured: 0, readable: false };
  Fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const basename = safeSessionFile(session.id);
  const indexFile = Path.join(directory, basename + ".index.json");
  const previous = loadIndex(indexFile);
  const { hashes, records } = computeRevisions(previous, {
    ...data,
    sessionId: session.id,
    observedAt: new Date().toISOString(),
  });
  if (!records.length) return { captured: 0, readable: true };
  const metadata = {
    version: 1,
    event: "session-metadata",
    sessionId: session.id,
    title: session.title ?? null,
    project: session.project ?? null,
    parentSessionId: session.parentSessionId ?? null,
    observedAt: new Date().toISOString(),
  };
  const journal = Path.join(directory, basename + ".jsonl");
  const descriptor = Fs.openSync(journal, "a", 0o600);
  try {
    Fs.writeSync(
      descriptor,
      [metadata, ...records].map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    Fs.fsyncSync(descriptor);
  } finally {
    Fs.closeSync(descriptor);
  }
  saveIndex(indexFile, hashes);
  return { captured: records.length, readable: true };
}

/** Reconstruct the latest observed version of each message from immutable journal events. */
export function readArchivedSession(sessionId, options = {}) {
  const directory = options.directory ?? DEFAULT_ARCHIVE_DIR;
  const file = Path.join(directory, safeSessionFile(sessionId) + ".jsonl");
  const latest = new Map();
  let metadata = null;
  let versions = 0;
  try {
    for (const line of Fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      } // Last append may have been interrupted; preserve earlier records.
      if (record.sessionId !== sessionId || record.version !== 1) continue;
      if (record.event === "session-metadata") {
        metadata = record;
        continue;
      }
      if (
        typeof record.conversationUrl !== "string" ||
        !["assistant", "user"].includes(record.role) ||
        !Number.isSafeInteger(record.turn) ||
        !Number.isSafeInteger(record.index) ||
        typeof record.text !== "string"
      )
        continue;
      const key =
        record.conversationUrl +
        "|" +
        (typeof record.turnKey === "string" ? record.turnKey : record.turn) +
        "|" +
        record.role +
        "|" +
        record.index;
      latest.set(key, record);
      versions++;
    }
  } catch (error) {
    if (error?.code === "ENOENT") return { sessionId, metadata: null, messages: [], revisions: 0 };
    throw error;
  }
  const messages = [...latest.values()].sort(
    (a, b) =>
      a.conversationUrl.localeCompare(b.conversationUrl) ||
      a.turn - b.turn ||
      (a.role === "user" ? -1 : 1) - (b.role === "user" ? -1 : 1) ||
      a.index - b.index,
  );
  return { sessionId, metadata, messages, revisions: versions };
}

export async function archiveOnce(options = {}) {
  const directory = options.directory ?? DEFAULT_ARCHIVE_DIR;
  const exchange = options.exchange ?? controlSessions;
  const reportError = options.onError ?? (() => {});
  const result = await exchange({ action: "list", which: "all" });
  if (!Array.isArray(result?.sessions)) throw new Error("Unexpected T3 session list");
  const sessions = result.sessions
    .filter((s) => s && s.hidden !== true && typeof s.id === "string")
    .sort((a, b) => (a.status === "working" ? -1 : 0) - (b.status === "working" ? -1 : 0))
    .slice(0, MAX_SESSIONS_PER_SCAN);
  let captured = 0;
  let readable = 0;
  let failures = 0;
  for (const session of sessions) {
    try {
      const receipt = await archiveSession(session, { directory, exchange });
      captured += receipt.captured;
      if (receipt.readable) readable++;
    } catch (error) {
      failures++;
      reportError(session.id, error);
    }
  }
  return { sessions: sessions.length, readable, captured, failures };
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const watch = args.includes("--watch");
  const readIndex = args.indexOf("--read-session");
  const dirIndex = args.indexOf("--dir");
  if (
    (once === watch && readIndex === -1) ||
    (readIndex !== -1 && (once || watch || !args[readIndex + 1])) ||
    (dirIndex >= 0 && !args[dirIndex + 1])
  )
    throw new Error(
      "Usage: node scripts/chatgpt-session-archive.mjs --once|--watch|--read-session SESSION_ID [--dir PATH]",
    );
  const directory = dirIndex >= 0 ? Path.resolve(args[dirIndex + 1]) : DEFAULT_ARCHIVE_DIR;
  if (readIndex !== -1) {
    console.log(JSON.stringify(readArchivedSession(args[readIndex + 1], { directory }), null, 2));
    return;
  }
  do {
    try {
      const result = await archiveOnce({
        directory,
        onError: (id, error) =>
          console.error("Session read failed:", safeSessionFile(id), String(error)),
      });
      console.log(
        "[ChatGPT archive] " +
          new Date().toISOString() +
          " sessions=" +
          result.sessions +
          " readable=" +
          result.readable +
          " revisions=" +
          result.captured +
          " errors=" +
          result.failures,
      );
    } catch (error) {
      console.error("[ChatGPT archive] Scan failed:", String(error));
      if (once) process.exitCode = 1;
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  } while (true);
}

if (process.argv[1] && Path.resolve(process.argv[1]) === URL.fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
