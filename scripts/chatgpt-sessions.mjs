#!/usr/bin/env node
/** Local-only ChatGPT browser session control, through T3 Code's existing named pipe.
 * Reads JSON arguments from stdin so messages do not appear in process arguments. */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { controlAddress, sendAppControlRequest } from "./spawn-chatgpt-session.mjs";

export async function controlSessions(
  input,
  { home = NodePath.resolve(import.meta.dirname, "../.t3"), exchange = sendAppControlRequest } = {},
) {
  const allowed = ["list", "open", "read", "send", "reconcile_send", "enqueue", "delivery_status", "delivery_list", "cancel_delivery", "reload", "complete", "archive", "restore", "change_state", "rollover_finalize", "wait"];
  if (input?.action === "wait") return waitForChatGPTSessions(input, { home, exchange });
  if (!input || !allowed.includes(input.action))
    throw new Error("action must be list, open, read, send, reconcile_send, reload, complete, archive, restore, change_state, rollover_finalize or wait.");
  if (
    input.which !== undefined &&
    (input.action !== "list" ||
      !["visible", "recent", "working", "blocked", "all"].includes(input.which))
  )
    throw new Error(
      "which applies only to list and must be visible, recent, working, blocked or all.",
    );
  if (!["list", "delivery_status", "delivery_list", "cancel_delivery"].includes(input.action) && !(typeof input.sessionId === "string" && input.sessionId.trim()))
    throw new Error("sessionId is required for read, send, reload, complete, archive, restore and change_state.");
  if (input.includeHidden !== undefined &&
      (input.action !== "list" || typeof input.includeHidden !== "boolean"))
    throw new Error("includeHidden is a boolean applying only to list.");
  if (input.action === "change_state" ?
      !["hidden", "unhidden", "closed"].includes(input.state) :
      input.state !== undefined)
    throw new Error("state=hidden|unhidden|closed is required only for change_state.");
  if (["send", "reconcile_send", "enqueue"].includes(input.action) && !(typeof input.message === "string" && input.message.trim()))
    throw new Error("Nonempty original message required for send or reconcile_send.");
  if (input.action === "enqueue" && !(typeof input.expectedConversationId === "string" && typeof input.messageId === "string"))
    throw new Error("enqueue requires expectedConversationId and caller-stable messageId.");
  if (["enqueue", "delivery_status", "cancel_delivery"].includes(input.action) && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.messageId ?? ""))
    throw new Error("A stable UUID messageId is required.");
  if (input.action === "reconcile_send" && !input.expectedConversationId)
    throw new Error("reconcile_send requires expectedConversationId.");
  if (input.wakeForSend !== undefined &&
      (input.action !== "read" || input.wakeForSend !== true))
    throw new Error("wakeForSend=true is only valid for one direct-send read preflight.");
  if (input.action === "send") {
    if (input.senderSessionId !== undefined &&
        (typeof input.senderSessionId !== "string" || !input.senderSessionId.trim()))
      throw new Error("senderSessionId must be a nonempty source ID.");
    if (input.expectedConversationId !== undefined &&
        (typeof input.expectedConversationId !== "string" ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.expectedConversationId)))
      throw new Error("expectedConversationId must be a canonical lowercase ChatGPT conversation UUID.");
    if (input.messageId !== undefined &&
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.messageId))
      throw new Error("Optional direct-send messageId must be a stable UUID.");
    // Legacy/direct T3 sends are durable too. A busy, recovering or cold guest
    // must NOT turn an instruction into a transient rejected click.
    // Resolve/wake only the exact addressed session, then persist the payload.
    // T3's desktop delivery queue owns ordered retries, not this CLI.
    const observed = await controlSessions({
      action: "read", sessionId: input.sessionId,
      count: 1, wakeForSend: true,
      ...(input.expectedConversationId ? {
        expectedConversationId: input.expectedConversationId,
      } : {}),
    }, { home, exchange });
    const conversationId = observed.verifiedConversationId;
    if (observed.conversationGuardValidated !== true ||
        typeof conversationId !== "string" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(conversationId) ||
        (input.expectedConversationId && input.expectedConversationId !== conversationId))
      throw new Error("T3 did not verify the exact mounted conversation; no direct send enqueued.");
    const messageId = input.messageId ?? NodeCrypto.randomUUID();
    const accepted = await controlSessions({
      action: "enqueue", messageId, sessionId: input.sessionId,
      expectedConversationId: conversationId, message: input.message,
    }, { home, exchange });
    if (accepted.messageId !== messageId ||
        accepted.conversationId !== conversationId ||
        accepted.sessionId !== input.sessionId || !accepted.status)
      throw new Error("T3 did not acknowledge the exact durable message and recipient.");
    return {
      ...accepted, action: "send",
      messageSent: accepted.status === "delivered",
      delivery: accepted.status === "delivered" ? "user_turn_observed" : "queued",
      conversationGuardValidated: true,
      verifiedConversationId: conversationId,
    };
  }
  if (
    input.senderSessionId !== undefined &&
    (input.action !== "send" ||
      typeof input.senderSessionId !== "string" ||
      !input.senderSessionId.trim())
  )
    throw new Error("senderSessionId is a nonempty source ID used only with send.");
  if (
    input.expectedConversationId !== undefined &&
    (!["read", "send", "reconcile_send", "enqueue"].includes(input.action) ||
      typeof input.expectedConversationId !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.expectedConversationId))
  ) {
    throw new Error(
      "expectedConversationId is a canonical lowercase /c/<uuid> ID for read or send.",
    );
  }
  if (input.action === "rollover_finalize" &&
      (!(typeof input.successorSessionId === "string" && input.successorSessionId.trim()) ||
       input.successorSessionId === input.sessionId ||
       !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.priorConversationId ?? "") ||
       !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.successorConversationId ?? "")))
    throw new Error("rollover_finalize requires distinct exact T3 browser IDs and two canonical conversation UUIDs.");
  if (input.action !== "rollover_finalize" &&
      (input.successorSessionId !== undefined || input.priorConversationId !== undefined ||
       input.successorConversationId !== undefined || input.recoveryMode !== undefined))
    throw new Error("Rollover identity fields apply only to rollover_finalize.");
  if (input.managerSessionId !== undefined)
    throw new Error("managerSessionId is not an authenticated authorization token.");
  if (
    input.managerDecision !== undefined &&
    (!['archive', 'rollover_finalize'].includes(input.action) || typeof input.managerDecision !== "boolean")
  )
    throw new Error("managerDecision is a boolean supported only for archive.");
  if (
    input.reason !== undefined &&
    (!['archive', 'rollover_finalize'].includes(input.action) ||
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      input.reason.length > 500 ||
      input.managerDecision !== true)
  )
    throw new Error("reason requires archive managerDecision=true and 1..500 characters.");
  if (input.action === "archive" && input.managerDecision === true && !input.reason?.trim())
    throw new Error("managerDecision requires a nonempty reason.");
  if (input.action === "rollover_finalize" && input.recoveryMode === true &&
      (input.managerDecision !== true || !input.reason?.trim()))
    throw new Error("Degraded rollover requires explicit managerDecision and a reason.");
  if (input.recoveryMode !== undefined && typeof input.recoveryMode !== "boolean")
    throw new Error("recoveryMode must be boolean.");
  const request = {
    version: 1,
    requestId: NodeCrypto.randomUUID(),
    type: "chatgpt.sessions",
    action: input.action,
    ...(input.action === "list" ? { which: input.which ?? "visible", includeHidden: input.includeHidden === true } : {}),
    ...(input.action === "change_state" ? { state: input.state } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.action === "rollover_finalize" ? {
      successorSessionId: input.successorSessionId,
      priorConversationId: input.priorConversationId,
      successorConversationId: input.successorConversationId,
      ...(input.recoveryMode !== undefined ? { recoveryMode: input.recoveryMode } : {}),
    } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.count !== undefined ? { count: input.count } : {}),
    ...(input.maxMessageChars !== undefined ? { maxMessageChars: input.maxMessageChars } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
    ...(input.wakeForSend === true ? { wakeForSend: true } : {}),
    ...(input.senderSessionId !== undefined ? { senderSessionId: input.senderSessionId } : {}),
    ...(input.expectedConversationId !== undefined
      ? { expectedConversationId: input.expectedConversationId }
      : {}),
    ...(input.force !== undefined ? { force: input.force } : {}),
    ...(input.managerDecision !== undefined ? { managerDecision: input.managerDecision } : {}),
    ...(input.reason !== undefined ? { reason: input.reason.trim() } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > 64 * 1024)
    throw new Error("Request exceeds the 64 KiB desktop limit.");
  // Old desktop versions may silently discard unfamiliar optional fields.
  // Probe a guarded READ before any guarded SEND; absent verification proves
  // the runtime cannot enforce the guard, so never submit a prompt to it.
  if (input.action === "send" && input.expectedConversationId !== undefined) {
    const probe = await exchange(
      controlAddress(home),
      {
        version: 1,
        requestId: NodeCrypto.randomUUID(),
        type: "chatgpt.sessions",
        action: "read",
        sessionId: input.sessionId,
        count: 1,
        expectedConversationId: input.expectedConversationId,
      },
      95_000,
    );
    if (
      !probe.ok ||
      probe.data?.conversationGuardValidated !== true ||
      probe.data?.verifiedConversationId !== input.expectedConversationId
    ) {
      throw new Error(
        "T3 desktop has not confirmed guarded reads; refusing send. Rebuild/restart T3.",
      );
    }
  }
  const response = await exchange(controlAddress(home), request, 95_000);
  if (!response.ok)
    throw new Error(`T3 Code rejected ${input.action}: ${response.code}: ${response.message}`);
  if (!Object.hasOwn(response, "data"))
    throw new Error(
      "T3 Code did not return session data. Rebuild and restart the updated desktop app.",
    );
  if (
    ["archive", "restore", "change_state", "rollover_finalize"].includes(input.action) &&
    ((input.action === "rollover_finalize" ? response.data?.priorSessionId : response.data?.sessionId) !== input.sessionId ||
      response.data?.persisted !== true ||
      response.data?.acknowledged !== true ||
      response.data?.action !== input.action ||
      (input.action === "change_state" && response.data?.state !== input.state))
  ) {
    throw new Error(`Desktop has not confirmed persisted ${input.action}; no success assumed.`);
  }
  if (
    input.expectedConversationId !== undefined && input.action !== "enqueue" &&
    (response.data?.conversationGuardValidated !== true ||
      response.data?.verifiedConversationId !== input.expectedConversationId)
  ) {
    throw new Error("Desktop response did not confirm expectedConversationId was enforced.");
  }
  return response.data;
}

/**
 * Wait locally rather than inside the desktop's serialized renderer dispatcher.
 * Each poll uses an independent, short named-pipe request so other sessions can
 * finish and send messages while the caller is waiting. Completion requires a
 * caller-declared marker, not an "idle" DOM heuristic.
 */
export async function waitForChatGPTSessions(
  input,
  {
    home = NodePath.resolve(import.meta.dirname, "../.t3"),
    exchange = sendAppControlRequest,
    now = Date.now,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const ids = input.sessionIds ?? (input.sessionId ? [input.sessionId] : []);
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 20 ||
    ids.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error("wait requires 1..20 distinct nonempty sessionIds (or one sessionId).");
  }
  if (input.mode !== undefined && !["any", "all"].includes(input.mode)) {
    throw new Error("wait mode must be any or all.");
  }
  const mode = input.mode ?? "all";
  const timeoutMs = input.timeoutMs ?? 30 * 60_000;
  const pollMs = input.pollMs ?? 3_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 24 * 60 * 60_000)
    throw new Error("wait timeoutMs must be 0..86400000.");
  if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 60_000)
    throw new Error("wait pollMs must be 1000..60000.");

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let last = [];
  while (true) {
    // Snapshot all requested sessions. Do not call the desktop with an
    // indefinite wait: a blocked renderer would prevent other agents' work.
    const inspected = await Promise.all(
      ids.map(async (id) => {
        const result = await controlSessions(
          { action: "read", sessionId: id, count: 1 },
          { home, exchange },
        );
        return result.session;
      }),
    );
    last = inspected.map((session, index) => ({
      sessionId: ids[index],
      completion: session?.completion ?? null,
      status: session?.status ?? "unavailable",
    }));
    const completed = last.filter((entry) => entry.completion !== null);
    if (mode === "any" ? completed.length > 0 : completed.length === ids.length) {
      return {
        mode,
        completed: true,
        matched: completed.map((entry) => entry.sessionId),
        pending: last.filter((entry) => !entry.completion).map((entry) => entry.sessionId),
        sessions: last,
        elapsedMs: now() - startedAt,
        basis: "caller_declared",
      };
    }
    if (now() >= deadline) {
      return {
        mode,
        completed: false,
        timedOut: true,
        matched: completed.map((entry) => entry.sessionId),
        pending: last.filter((entry) => !entry.completion).map((entry) => entry.sessionId),
        sessions: last,
        elapsedMs: now() - startedAt,
        basis: "caller_declared",
      };
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

export async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(
    Buffer.concat(chunks)
      .toString("utf8")
      .replace(/^\uFEFF/, ""),
  );
  const data = await controlSessions(input);
  process.stdout.write(JSON.stringify(data) + "\n");
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
