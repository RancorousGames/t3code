#!/usr/bin/env node
// Read-only T3 server-registry projection for local OmniHub MCP list.
// This never opens a ChatGPT guest or writes the server database. The existing
// desktop pipe remains the transport for actions until server-RPC routing is live.
import { DatabaseSync } from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const DEFAULT_HOME = NodePath.join(ROOT, ".t3");
const LEASE_MS = 15_000;
const parseJson = (text) => {
  if (typeof text !== "string" || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const isRow = (row) => row && typeof row === "object" && !Array.isArray(row);
const safeText = (v, max = 3000) => (typeof v === "string" ? v.slice(0, max) : null);
const maybeId = (v) => (typeof v === "string" && UUID.test(v) ? v : null);

export function isExactConversationUrl(value, conversationId) {
  if (!maybeId(conversationId) || typeof value !== "string") return false;
  try {
    const url = new globalThis.URL(value);
    if (
      !["https://chatgpt.com", "https://chat.openai.com"].includes(url.origin) ||
      url.username ||
      url.password ||
      url.hash
    )
      return false;
    const path = url.pathname.replace(/\/$/, "");
    const match = /^\/(?:g\/g-[a-z0-9_-]+\/)?c\/([a-f0-9-]{36})$/i.exec(path);
    return !!match && match[1].toLowerCase() === conversationId.toLowerCase();
  } catch {
    return false;
  }
}

export function readRegistryList(input, { home = DEFAULT_HOME, now = Date.now() } = {}) {
  const which = input?.which ?? "visible";
  if (!["visible", "recent", "working", "blocked", "all"].includes(which))
    throw new Error("Invalid T3 registry list filter.");
  if (input?.includeHidden !== undefined && typeof input.includeHidden !== "boolean")
    throw new Error("includeHidden must be boolean.");
  const base = NodePath.join(home, "userdata");
  const dbPath = NodePath.join(base, "statev2.sqlite");
  const environmentId = NodeFS.readFileSync(NodePath.join(base, "environment-id"), "utf8").trim();
  if (!environmentId || !NodeFS.existsSync(dbPath))
    throw new Error("T3 server registry unavailable: missing environment binding or database.");

  // SQLite read-only mode means MCP can answer during renderer restarts.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('chatgpt_session_registry','chatgpt_registry_drivers')",
      )
      .all();
    if (tables.length !== 2)
      throw new Error(
        "T3 server registry not migrated; update T3 server before using registry list.",
      );
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(chatgpt_session_registry)")
        .all()
        .map((r) => r.name),
    );
    const hasClosures = columns.has("closed_at");
    const closedField = hasClosures ? "closed_at" : "NULL AS closed_at";
    const closedFilter =
      hasClosures && input?.includeClosed !== true ? " AND closed_at IS NULL" : "";
    const rows = db
      .prepare(
        `SELECT session_id,record_json,snapshot_json,updated_at,${closedField} FROM chatgpt_session_registry WHERE environment_id=?${closedFilter} ORDER BY updated_at DESC,session_id`,
      )
      .all(environmentId);
    const driverRow = db
      .prepare("SELECT driver_id,last_seen_at FROM chatgpt_registry_drivers WHERE environment_id=?")
      .get(environmentId);
    const driverOnline =
      !!driverRow &&
      now - Number(driverRow.last_seen_at) >= 0 &&
      now - Number(driverRow.last_seen_at) < LEASE_MS;

    const sessions = rows.flatMap((row) => {
      const record = parseJson(row.record_json);
      if (!isRow(record) || record.id !== row.session_id || !maybeId(row.session_id)) return [];
      const hidden = record.hidden === true;
      if (hidden && input.includeHidden !== true) return [];
      const bootstrap = isRow(record.bootstrapIdentity) ? record.bootstrapIdentity : null;
      const publicId =
        maybeId(bootstrap?.publicId) &&
        (bootstrap?.state === "registered" ||
          (record.creationOrigin === "backend" && typeof record.spawnRequestId === "string"))
          ? maybeId(bootstrap.publicId)
          : null;
      // A manual guest without an observed Bootstrap marker has a private
      // browser key, not a remotely routable public session identity.
      if (record.creationOrigin === "manual" && !publicId) return [];
      const snapshot = parseJson(row.snapshot_json);
      const activity =
        isRow(snapshot) && typeof snapshot.activity === "string" ? snapshot.activity : "unknown";
      if (which === "working" && activity !== "working") return [];
      if (which === "blocked" && !["interrupted", "failed"].includes(activity)) return [];
      let conversationId =
        maybeId(isRow(snapshot) ? snapshot.conversationId : null) ?? maybeId(record.conversationId);
      const url = safeText(isRow(snapshot) ? snapshot.url : null, 512) ?? safeText(record.url, 512);
      if (url && conversationId && !isExactConversationUrl(url, conversationId))
        conversationId = null;
      const lastAssistant = safeText(isRow(snapshot) ? snapshot.lastAssistantText : null);
      const lastUser = safeText(isRow(snapshot) ? snapshot.lastUserText : null);
      return [
        {
          id: publicId ?? row.session_id,
          browserSessionId: row.session_id,
          publicSessionId: publicId,
          closedAt: row.closed_at,
          title: safeText(record.title, 160) ?? "Untitled ChatGPT session",
          project: safeText(record.project, 128),
          parentSessionId: maybeId(record.parentSessionId),
          conversationId,
          url: conversationId ? url : null,
          hidden,
          snoozedUntil: typeof record.snoozedUntil === "number" ? record.snoozedUntil : null,
          binding: isRow(record.binding) ? record.binding : null,
          bootstrapIdentity: isRow(record.bootstrapIdentity) ? record.bootstrapIdentity : null,
          completion: isRow(record.completion) ? record.completion : null,
          lastWorkingAt: typeof record.lastWorkingAt === "number" ? record.lastWorkingAt : null,
          activity: driverOnline ? activity : "unavailable",
          status: driverOnline ? activity : "driver_offline",
          statusReason: driverOnline
            ? "Server-registry snapshot (may be stale)."
            : "Desktop driver offline; live actions unavailable. No request was queued.",
          statusObservedAt: new Date(Number(row.updated_at)).toISOString(),
          lastRole: lastAssistant ? "assistant" : lastUser ? "user" : null,
          lastText: lastAssistant ?? lastUser,
          totalTurns:
            isRow(snapshot) && Number.isInteger(snapshot.turnCount) ? snapshot.turnCount : null,
          messages: [],
          source: "t3-server-registry",
          stale: !driverOnline,
        },
      ];
    });
    // Recent and other filters preserve registry's server-side updated_at ordering.
    const limited = which === "recent" ? sessions.slice(0, 20) : sessions;
    return {
      sessions: limited,
      total: limited.length,
      which,
      source: "t3-server-registry",
      driverOnline,
      driverLastSeenAt: driverRow?.last_seen_at ?? null,
      environmentId,
    };
  } finally {
    db.close();
  }
}

/**
 * Query immediate children from the same read-only registry used by list.
 * Both public Bootstrap IDs and browser IDs resolve to the same parent.
 * No guest is hydrated and no message content is returned.
 */
export function readRegistryChildren(input, options = {}) {
  const parentId = maybeId(input?.sessionId);
  if (!parentId) throw new Error("children requires an exact parent sessionId UUID.");
  const now = options.now ?? Date.now();
  const registry = readRegistryList(
    { action: "list", which: "all", includeHidden: true, includeClosed: true },
    { ...options, now },
  );
  const parent = registry.sessions.find(
    (session) => session.id === parentId || session.browserSessionId === parentId,
  );
  const aliases = new Set([parentId, parent?.id, parent?.browserSessionId].filter(Boolean));
  const children = registry.sessions
    .filter((session) => session.parentSessionId && aliases.has(session.parentSessionId))
    .filter((session) => input?.includeClosed === true || session.closedAt == null)
    .map((session) => {
      const observedAt = Date.parse(session.statusObservedAt);
      const taskRef = session.binding?.taskRef;
      const activeTask =
        typeof taskRef === "string" ? taskRef
        : isRow(taskRef) && typeof taskRef.id === "string" ? taskRef.id
        : null;
      return {
        sessionId: session.id,
        browserSessionId: session.browserSessionId,
        title: session.title,
        project: session.project,
        activity: session.activity,
        status: session.status,
        statusObservedAt: session.statusObservedAt,
        secondsSinceUpdate: Number.isFinite(observedAt) ? Math.max(0, Math.floor((now - observedAt) / 1000)) : null,
        lastWorkingAt: session.lastWorkingAt,
        activeTask,
        hidden: session.hidden,
        closedAt: session.closedAt,
        stale: session.stale,
      };
    });
  return {
    parentSessionId: parentId,
    children,
    total: children.length,
    source: registry.source,
    driverOnline: registry.driverOnline,
  };
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 32_768) throw new Error("Oversized T3 list request.");
  }
  try {
    const args = JSON.parse(input);
    if (!["list", "children"].includes(args?.action)) throw new Error("Registry read supports list or children only.");
    process.stdout.write(JSON.stringify(args.action === "children" ? readRegistryChildren(args) : readRegistryList(args)));
  } catch (error) {
    process.stderr.write(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
