#!/usr/bin/env node
/**
 * Local OmniHub/MCP adapter for T3's persistent ChatGPT server registry.
 * Only the server Registry service writes actions. The desktop driver remains
 * the sole sender/reconciler. Never fall back to the renderer's named pipe.
 */
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";
import * as URL from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readRegistryList, isExactConversationUrl } from "../../../scripts/t3-registry-read.mjs";

const ROOT = Path.resolve(Path.dirname(URL.fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_HOME = Path.join(ROOT, ".t3");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// A registered Bootstrap marker is verified ownership of a conversation,
// unlike a title, URL guess or unregistered/pending identity. A live guarded
// READ may use it when migration left the server page snapshot absent.
const registeredConversationId = (record) => {
  const identity = record?.bootstrapIdentity;
  return identity?.state === "registered" &&
    typeof identity.conversationId === "string" &&
    UUID.test(identity.conversationId)
    ? identity.conversationId
    : null;
};
const versionSupportsRegistry = () => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major >= 24 || (major === 23 && minor >= 11) || (major === 22 && minor >= 16);
};
const dbInfo = (home) => {
  const folder = Path.join(home, "userdata");
  const dbPath = Path.join(folder, "statev2.sqlite");
  const environmentId = Fs.readFileSync(Path.join(folder, "environment-id"), "utf8").trim();
  if (!UUID.test(environmentId)) throw new Error("T3 environment identity is missing or invalid.");
  return { dbPath, environmentId };
};
function hasMigratedRegistry(dbPath) {
  if (!Fs.existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const names = new Set(
      db
        .prepare("PRAGMA table_info(chatgpt_session_registry)")
        .all()
        .map((r) => r.name),
    );
    const drivers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chatgpt_registry_drivers'",
      )
      .get();
    return (
      !!drivers &&
      ["metadata_revision", "metadata_patch_json", "timeline_json", "closed_at"].every((name) =>
        names.has(name),
      )
    );
  } finally {
    db.close();
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bad = (reason) => ({ ok: false, status: "refused", reason });
const publicReceipt = (action, result, publicSessionId = null) => ({
  action,
  requestId: result.requestId,
  sessionId: publicSessionId ?? result.sessionId,
  status:
    result.resolvedAt === null
      ? result.dispatchedAt === null
        ? "queued"
        : "submitted_uncertain"
      : result.actionId === "read" && result.result?.ok === true
        ? "guarded_read_completed"
        : result.result?.deliveryObserved === true
          ? "delivered"
          : result.result?.ok === true
            ? "accepted_not_observed"
            : "refused",
  messageSent: result.result?.deliveryObserved === true,
  delivery: result.result?.deliveryObserved === true ? "user_turn_observed" : "unconfirmed",
  resolved: result.resolvedAt !== null,
  ...(result.result && {
    result: {
      ok: result.result.ok === true,
      status: typeof result.result.status === "string" ? result.result.status : null,
      reason: typeof result.result.reason === "string" ? result.result.reason : null,
    },
  }),
  ...((action === "read" || result.actionId === "read") && result.result?.ok === true
    ? {
        verifiedConversationId:
          typeof result.result.verifiedConversationId === "string"
            ? result.result.verifiedConversationId
            : null,
        totalTurns: Number.isSafeInteger(result.result.totalTurns)
          ? result.result.totalTurns
          : null,
        pageStatus:
          typeof result.result.pageStatus === "string" ? result.result.pageStatus : "unavailable",
        pageActivity:
          typeof result.result.pageActivity === "string" ? result.result.pageActivity : "unknown",
        pageLastRole:
          result.result.pageLastRole === "user" || result.result.pageLastRole === "assistant"
            ? result.result.pageLastRole
            : null,
        pageObservedAt:
          typeof result.result.pageObservedAt === "string" ? result.result.pageObservedAt : null,
        messages: Array.isArray(result.result.messages)
          ? result.result.messages.slice(0, 20).map((message) => ({
              role: message.role === "user" ? "user" : "assistant",
              text: String(message.text ?? "").slice(0, 2_000),
              turn: Number.isSafeInteger(message.turn) ? message.turn : null,
            }))
          : [],
        snapshotOnly: false,
      }
    : {}),
});

/** Keep this function injectable so the registry can be proven in isolation. */
export async function runRegistryMcpAction(
  input,
  { home = DEFAULT_HOME, pollCount = 12, pollIntervalMs = 500 } = {},
) {
  if (
    !input ||
    !["read", "send", "when_idle", "reload", "complete", "receipt"].includes(input.action)
  )
    throw new Error("Expected read, send, when_idle, reload, complete or receipt.");
  if (
    input.action === "receipt" &&
    (typeof input.requestId !== "string" || !UUID.test(input.requestId))
  )
    return bad("Receipt lookup requires the original stable requestId UUID.");
  const info = dbInfo(home);
  const registryReady = versionSupportsRegistry() && hasMigratedRegistry(info.dbPath);
  if (
    input.action !== "receipt" &&
    (typeof input.sessionId !== "string" || !UUID.test(input.sessionId))
  ) {
    return bad("Unknown or uninitialized T3 session ID. Bootstrap with given_id and retry.");
  }
  let snapshotRead = null;
  if (input.action === "read") {
    const list = readRegistryList(
      { action: "list", which: "all", includeHidden: true, includeClosed: true },
      { home },
    );
    const session = list.sessions.find((item) => item.id === input.sessionId);
    if (!session) return bad("Uninitialized T3 session ID; no server record exists.");
    const db = new DatabaseSync(info.dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT snapshot_json FROM chatgpt_session_registry WHERE environment_id=? AND session_id=?",
        )
        .get(info.environmentId, session.browserSessionId);
      const snapshot = row?.snapshot_json ? JSON.parse(row.snapshot_json) : null;
      const messages = [
        ...(snapshot?.lastUserText
          ? [{ role: "user", text: String(snapshot.lastUserText).slice(0, 2_000) }]
          : []),
        ...(snapshot?.lastAssistantText
          ? [{ role: "assistant", text: String(snapshot.lastAssistantText).slice(0, 2_000) }]
          : []),
      ];
      snapshotRead = {
        action: "read",
        sessionId: session.id,
        title: session.title,
        conversationId: session.conversationId,
        verifiedConversationId: session.conversationId,
        conversationGuardValidated: false,
        messages,
        snapshotOnly: true,
        stale: session.stale,
        driverOnline: list.driverOnline,
        status: session.stale ? "driver_offline" : "last_known_snapshot",
        note: "Latest snapshot only; no renderer or guest was contacted.",
      };
      if (
        !registryReady ||
        !list.driverOnline ||
        !(session.conversationId || registeredConversationId(session)) ||
        session.closedAt !== null
      )
        return snapshotRead;
    } finally {
      db.close();
    }
  }
  // Never replay server actions through the renderer pipe during an upgrade.
  if (!registryReady)
    return bad(
      "T3 registry migrations 064-066 not active; no desktop action queued. Deploy upgraded server.",
    );
  if (input.requestId !== undefined && !UUID.test(input.requestId))
    return bad("Request ID must be a stable canonical UUID.");
  const requestId = input.requestId ?? Crypto.randomUUID();
  const [Effect, Layer, Registry, NodeSqliteClient] = await Promise.all([
    import("effect/Effect"),
    import("effect/Layer"),
    import("../src/chatGPTSessionRegistry.ts"),
    import("@t3tools/shared/nodeSqliteClient"),
  ]);
  const registryLayer = Registry.layer.pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: info.dbPath })),
  );
  const task = Effect.gen(function* () {
    const registry = yield* Registry.ChatGPTSessionRegistry;
    if (input.action === "receipt") {
      const receipt = yield* registry.getAction(requestId);
      if (!receipt || receipt.environmentId !== info.environmentId)
        return { action: "receipt", requestId, status: "not_found", resolved: false };
      const target = yield* registry.get(info.environmentId, receipt.sessionId);
      return publicReceipt("receipt", receipt, target?.publicSessionId);
    }
    const session = yield* registry.get(info.environmentId, input.sessionId);
    if (!session && !["send", "when_idle"].includes(input.action))
      return bad("Uninitialized T3 session ID; no server record exists.");
    // An archived/closed session may still have a useful last snapshot but
    // must never cause a live desktop action (including a read that wakes it).
    if (session?.closedAt !== null && session?.closedAt !== undefined)
      return snapshotRead ?? bad("Session is closed; no live action queued.");
    const args = {};
    if (input.action === "read") {
      args.count = input.count ?? 3;
      args.from = input.from ?? "end";
      const snapshotId = isExactConversationUrl(
        session.snapshot?.url,
        session.snapshot?.conversationId,
      )
        ? session.snapshot.conversationId
        : null;
      const bindingId = snapshotId ?? registeredConversationId(session.record);
      args.expectedConversationId = input.expectedConversationId ?? bindingId;
      if (
        !Number.isInteger(args.count) ||
        args.count < 1 ||
        args.count > 20 ||
        !["start", "end"].includes(args.from) ||
        !UUID.test(args.expectedConversationId ?? "") ||
        !bindingId ||
        bindingId !== args.expectedConversationId
      ) {
        return snapshotRead ?? bad("Read requires an exact saved conversation binding.");
      }
    }
    if (input.action === "send" || input.action === "when_idle") {
      const message = input.message;
      if (typeof message !== "string" || !message.trim() || message.length > 8_000)
        return bad("Message must be 1–8000 characters.");
      // A registered Bootstrap identity is sufficient when the renderer snapshot
      // has not yet populated its conversation URL. Match the guarded-read path.
      const snapshotId = isExactConversationUrl(
        session?.snapshot?.url,
        session?.snapshot?.conversationId,
      )
        ? session.snapshot.conversationId
        : null;
      const bindingId = session ? (snapshotId ?? registeredConversationId(session.record)) : null;
      const expected = input.expectedConversationId ?? bindingId;
      if (
        (expected !== null && expected !== undefined && !UUID.test(expected)) ||
        (bindingId && expected !== bindingId)
      ) {
        return bad("Cannot verify exact registered conversation. No message was queued.");
      }
      args.message = message;
      if (expected) args.expectedConversationId = expected;
    }
    const receipt = yield* registry.requestAction({
      requestId,
      environmentId: info.environmentId,
      sessionId: input.sessionId,
      actionId: input.action,
      args,
    });
    if (receipt.resolvedAt !== null)
      return receipt.result?.ok === false && snapshotRead
        ? snapshotRead
        : publicReceipt(input.action, receipt, session?.publicSessionId);
    // Poll the existing receipt only. Never re-submit the action.
    for (let attempt = 0; attempt < pollCount; attempt++) {
      yield* Effect.promise(() => sleep(pollIntervalMs));
      const status = yield* registry.getAction(requestId);
      if (status?.resolvedAt != null)
        return status.result?.ok === false && snapshotRead
          ? snapshotRead
          : publicReceipt(input.action, status, session?.publicSessionId);
    }
    const status = yield* registry.getAction(requestId);
    if (snapshotRead)
      return {
        ...snapshotRead,
        requestId,
        status: status?.dispatchedAt ? "live_read_submitted_uncertain" : "live_read_queued",
        note: "Latest snapshot shown; full live read is pending. Poll this requestId for its receipt.",
      };
    return status
      ? publicReceipt(input.action, status, session?.publicSessionId)
      : { action: input.action, requestId, status: "unknown", resolved: false };
  });
  return Effect.runPromise(
    task.pipe(
      Effect.catchTag("ChatGPTDriverUnavailable", (error) => Effect.succeed(bad(error.message))),
      Effect.provide(registryLayer),
    ),
  );
}

if (process.argv[1] && Path.resolve(process.argv[1]) === URL.fileURLToPath(import.meta.url)) {
  let payload = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    payload += chunk;
    if (payload.length > 60_000) throw new Error("MCP request exceeds 60 KiB.");
  }
  try {
    process.stdout.write(JSON.stringify(await runRegistryMcpAction(JSON.parse(payload))));
  } catch (error) {
    process.stderr.write(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
