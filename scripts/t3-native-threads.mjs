#!/usr/bin/env node
/** Native T3 threads over the running desktop's *existing* Windows named pipe.
 * No OAuth registration, browser approval, pairing, or new listener.
 */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { controlAddress, sendAppControlRequest } from "./spawn-chatgpt-session.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// Read/send are lookups of EXISTING durable T3 threads, not permissions to
// create them. Preserve opaque MCP identities exactly, including valid %HH
// encoded components. Never decode, normalize, or infer a different recipient.
const READ_SEND_THREAD_ID = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|mcp:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|thread:mcp:(?:[A-Za-z0-9._~:-]|%[0-9a-f]{2}){1,240})$/i;
const readableThreadId = (id) => {
  if (typeof id !== "string" || id.length > 256 || id.includes("..") || !READ_SEND_THREAD_ID.test(id))
    return false;
  try {
    // Validate encoding without replacing the opaque original. Encoded control
    // characters and malformed UTF-8 must never become a target thread ID.
    const decoded = decodeURIComponent(id);
    return !decoded.includes("..") && ![...decoded].some((char) => /\s/u.test(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  } catch {
    return false;
  }
};

export async function controlNativeThreads(
  input,
  { home = NodePath.resolve(import.meta.dirname, "../.t3"), exchange = sendAppControlRequest } = {},
) {
  if (!input || !["list", "read", "send", "create", "providers"].includes(input.action))
    throw new Error("action must be list, read, send, create or providers");
  if (["read", "send"].includes(input.action) && !readableThreadId(input.threadId))
    throw new Error("threadId must be a native T3 UUID or valid opaque MCP thread ID");
  const expectedEnvironmentId = input.expectedEnvironmentId ?? input.environmentId;
  if (
    expectedEnvironmentId !== undefined &&
    (typeof expectedEnvironmentId !== "string" ||
      !expectedEnvironmentId.trim() ||
      expectedEnvironmentId.length > 128)
  )
    throw new Error("expectedEnvironmentId must be a nonempty environment identity");
  if (
    input.action === "send" &&
    (typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.length > 30_000 ||
      !UUID.test(input.clientRequestId ?? ""))
  )
    throw new Error("send requires a message <= 30,000 chars and a UUID clientRequestId");
  if (
    !["send", "create"].includes(input.action) &&
    (input.message !== undefined || input.clientRequestId !== undefined)
  )
    throw new Error("message/clientRequestId apply only to send/create");
  if (input.action === "create") {
    if (!expectedEnvironmentId) throw new Error("create requires exact expectedEnvironmentId");
    if (typeof input.workspaceRoot !== "string" ||
        input.workspaceRoot.length > 2048 ||
        !/^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+|\/)/.test(input.workspaceRoot))
      throw new Error("create requires absolute workspaceRoot");
    if (input.projectId !== undefined && !UUID.test(input.projectId))
      throw new Error("create projectId must be a UUID");
    if (!["codex", "claude", "opencode"].includes(input.runtime))
      throw new Error("create runtime must be codex, claude or opencode");
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(input.providerInstanceId ?? ""))
      throw new Error("create requires exact providerInstanceId");
    if (!input.modelSelection ||
        input.modelSelection.instanceId !== input.providerInstanceId ||
        typeof input.modelSelection.model !== "string" ||
        !input.modelSelection.model.trim() ||
        input.modelSelection.model.length > 256)
      throw new Error("create requires explicit modelSelection and matching instanceId");
    if (!["approval-required", "auto-accept-edits", "auto", "full-access"].includes(input.runtimeMode))
      throw new Error("create requires explicit runtimeMode");
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200)
      throw new Error("create requires nonblank title <= 200 chars");
    if (!UUID.test(input.clientRequestId ?? ""))
      throw new Error("create requires stable UUID clientRequestId");
    if ((input.firstMessage === undefined) !== (input.initialMessageId === undefined))
      throw new Error("create firstMessage requires initialMessageId and vice versa");
    if (input.firstMessage !== undefined &&
        (typeof input.firstMessage !== "string" || !input.firstMessage.trim() ||
         input.firstMessage.length > 30_000 || !UUID.test(input.initialMessageId)))
      throw new Error("create requires nonempty firstMessage and exact message UUID");
  }
  const permitted = {
    list: ["action", "environmentId", "expectedEnvironmentId"],
    providers: ["action", "environmentId", "expectedEnvironmentId"],
    read: ["action", "environmentId", "expectedEnvironmentId", "threadId", "count"],
    send: ["action", "environmentId", "expectedEnvironmentId", "threadId", "message", "clientRequestId"],
    create: ["action", "environmentId", "expectedEnvironmentId", "workspaceRoot", "projectId",
      "runtime", "providerInstanceId", "modelSelection", "runtimeMode", "title",
      "clientRequestId", "firstMessage", "initialMessageId"],
  };
  if (Object.keys(input).some((key) => !permitted[input.action].includes(key)))
    throw new Error("Native thread control includes fields incompatible with action");
  if (
    input.count !== undefined &&
    (input.action !== "read" ||
      !Number.isInteger(input.count) ||
      input.count < 1 ||
      input.count > 20)
  )
    throw new Error("count must be 1..20 and only applies to read");
  const request = {
    version: 1,
    requestId: NodeCrypto.randomUUID(),
    type: "t3.threads",
    action: input.action,
    ...(expectedEnvironmentId ? { environmentId: expectedEnvironmentId } : {}),
    ...(["read", "send"].includes(input.action) ? { threadId: input.threadId } : {}),
    ...(input.count ? { count: input.count } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
    ...(input.action === "create" ? {
      workspaceRoot: input.workspaceRoot,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      runtime: input.runtime,
      providerInstanceId: input.providerInstanceId,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      title: input.title,
      ...(input.firstMessage === undefined ? {} : {
        firstMessage: input.firstMessage,
        initialMessageId: input.initialMessageId,
      }),
    } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > 64 * 1024)
    throw new Error("Native thread control request exceeds 64 KiB");
  if (["read", "send"].includes(input.action) && !UUID.test(input.threadId)) {
    // Only the ACTUALLY RUNNING desktop may advertise opaque support; a newer
    // script, model claim, or local source schema is never proof. Ask over the
    // already existing v1 read-only list route, never via create/reserve.
    if (!expectedEnvironmentId)
      throw new Error("Opaque native thread read/send requires exact expectedEnvironmentId");
    const capabilityRequest = {
      version: 1, requestId: NodeCrypto.randomUUID(), type: "t3.threads",
      action: "list", environmentId: expectedEnvironmentId,
    };
    const advertised = await exchange(controlAddress(home), capabilityRequest, 95_000);
    const capabilities = advertised?.data?.nativeThreadMessaging;
    if (
      advertised?.requestId !== capabilityRequest.requestId ||
      advertised?.version !== 1 || advertised?.ok !== true ||
      advertised.data?.environmentId !== expectedEnvironmentId ||
      capabilities?.version !== 1 ||
      capabilities?.environmentId !== expectedEnvironmentId ||
      capabilities?.threadIdGrammar !== "t3-native-opaque-read-send-v1" ||
      capabilities?.readOpaqueThreadIds !== true ||
      capabilities?.sendOpaqueThreadIds !== true
    )
      throw new Error("Running T3 desktop lacks exact environment-bound opaque read+send capability; UUID-only, no message sent");
  }
  // A timed-out create or send may still have committed; never retry or imply failure.
  const response = await exchange(controlAddress(home), request, 95_000);
  if (response.requestId !== request.requestId || response.version !== 1)
    throw new Error("Desktop response correlation failed");
  if (!response.ok)
    throw new Error("T3 native threads: " + response.code + ": " + response.message);
  if (!Object.hasOwn(response, "data"))
    throw new Error("Running T3 desktop lacks native-thread control. Rebuild/restart T3.");
  if (
    typeof response.data?.environmentId !== "string" ||
    !response.data.environmentId.trim() ||
    (expectedEnvironmentId && response.data.environmentId !== expectedEnvironmentId)
  )
    throw new Error("T3 desktop returned the wrong native environment");
  if (
    ["read", "send"].includes(input.action) &&
    response.data?.threadId !== input.threadId
  )
    throw new Error("T3 desktop returned a mismatched native thread recipient; do not retry");
  if (input.action === "read" && !Array.isArray(response.data?.messages))
    throw new Error("T3 native read lacked a message list from the exact recipient");
  if (
    input.action === "send" &&
    (response.data?.messageSent !== true || response.data?.messageId !== input.clientRequestId)
  )
    throw new Error("T3 native send lacked exact message acknowledgement; do not retry");
  if (input.action === "providers" &&
      (!Array.isArray(response.data?.providers) ||
       response.data.providers.some((provider) =>
         typeof provider.providerInstanceId !== "string" ||
         typeof provider.driver !== "string" || !Array.isArray(provider.models)))) {
    throw new Error("T3 native provider catalog response malformed; rebuild/restart T3");
  }
  if (input.action === "create") {
    const data = response.data;
    const canonical = (value) => typeof value === "string"
      ? value.replaceAll("/", "\\").replace(/[\\\\]+$/, "").toLowerCase() : null;
    if (data?.action !== "create" || data.created !== true ||
        data.threadId !== input.clientRequestId || !UUID.test(data.projectId ?? "") ||
        (input.projectId && data.projectId !== input.projectId) ||
        canonical(data.workspaceRoot) !== canonical(input.workspaceRoot) ||
        data.runtime !== input.runtime ||
        data.providerInstanceId !== input.providerInstanceId ||
        data.modelSelection?.instanceId !== input.providerInstanceId ||
        data.modelSelection?.model !== input.modelSelection.model ||
        (input.firstMessage === undefined
          ? data.messageSent !== false || data.messageId !== undefined
          : data.messageSent !== true || data.messageId !== input.initialMessageId))
      throw new Error("Native create lacked exact persisted thread/provider/message acknowledgement; reconcile by clientRequestId, do not retry");
  }
  return response.data;
}

export async function main() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > 64 * 1024) throw new Error("Native control stdin exceeds 64 KiB");
    chunks.push(chunk);
  }
  const input = JSON.parse(
    Buffer.concat(chunks)
      .toString("utf8")
      .replace(/^\uFEFF/, ""),
  );
  process.stdout.write(JSON.stringify(await controlNativeThreads(input)) + "\n");
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
