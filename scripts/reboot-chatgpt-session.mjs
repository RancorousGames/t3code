#!/usr/bin/env node
/**
 * Agent Reboot of ANY existing T3 ChatGPT browser session; OpenRig is optional.
 *
 * The caller must supply an exact stable T3 browser UUID, or its own
 * ChatGPT conversation UUID/URL for an unambiguous lookup. An agent should
 * summarize its current work into --message-file BEFORE rebooting itself.
 *
 * Examples:
 *   node scripts/reboot-chatgpt-session.mjs --session-id UUID --message-file handoff.txt
 *   node scripts/reboot-chatgpt-session.mjs --conversation-url https://chatgpt.com/c/UUID --message-file handoff.txt
 *   node scripts/reboot-chatgpt-session.mjs --session-id UUID --request-id OPERATION-UUID --phase status
 *   node scripts/reboot-chatgpt-session.mjs --session-id UUID --request-id OPERATION-UUID --phase finalize
 *
 * Uncertain begin responses must NOT be retried. Reconcile via status/finalize
 * using the original operation ID; this script never starts a second browser.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controlAddress, sendAppControlRequest } from "./spawn-chatgpt-session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function conversationIdFromUrl(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return ["chatgpt.com", "chat.openai.com"].includes(parsed.hostname) &&
      parsed.protocol === "https:" && parsed.port === "" ?
      /^\/c\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/|$)/i.exec(parsed.pathname)?.[1] ?? null
      : null;
  } catch { return null; }
}

export function parseRebootArgs(argv) {
  const out = { phase: "begin", home: path.join(ROOT, ".t3") };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return null;
    if (!["--session-id", "--conversation-id", "--conversation-url", "--request-id",
           "--message", "--message-file", "--phase", "--home"].includes(flag))
      throw new Error("Unknown argument: " + flag);
    const value = argv[++i];
    if (!value) throw new Error("Missing value after " + flag);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, x) => x.toUpperCase());
    out[key] = value;
  }
  if (!["begin", "status", "finalize"].includes(out.phase))
    throw new Error("--phase must be begin, status or finalize");
  if (out.sessionId && !UUID.test(out.sessionId))
    throw new Error("--session-id must be an exact existing T3 browser UUID");
  if (out.conversationUrl) {
    const id = conversationIdFromUrl(out.conversationUrl);
    if (!id) throw new Error("--conversation-url must be an exact ChatGPT /c/<uuid> URL");
    if (out.conversationId && out.conversationId !== id)
      throw new Error("Conversation ID disagrees with the URL");
    out.conversationId = id;
  }
  if (out.conversationId && !UUID.test(out.conversationId))
    throw new Error("--conversation-id must be a ChatGPT conversation UUID");
  if (!out.sessionId && !out.conversationId)
    throw new Error("Specify --session-id or --conversation-id/--conversation-url (no selected-tab guess).");
  if (out.requestId && !UUID.test(out.requestId))
    throw new Error("--request-id must be an exact UUID");
  if (out.phase !== "begin" && !out.requestId)
    throw new Error("Status/finalize require --request-id; do not guess a new reboot.");
  if (out.message && out.messageFile)
    throw new Error("Choose --message or --message-file.");
  if (out.messageFile) out.message = fs.readFileSync(path.resolve(out.messageFile), "utf8");
  if (out.phase === "begin" && !out.message?.trim())
    throw new Error("Write a continuation summary and supply --message or --message-file.");
  if (out.phase !== "begin" && (out.message || out.messageFile))
    throw new Error("Status/finalize never resend an initial message.");
  return out;
}

export async function rebootExistingT3Session(
  args,
  { exchange = sendAppControlRequest } = {},
) {
  const address = controlAddress(args.home);
  // T3's session index, not OpenRig seat data, resolves a conversation URL to
  // one and only one local browser UUID. No hidden-session filter applies.
  let sessionId = args.sessionId;
  if (args.conversationId) {
    const lookupId = randomUUID();
    const index = await exchange(address, {
      version: 1, requestId: lookupId, type: "chatgpt.sessions",
      action: "list", which: "all", includeHidden: true,
    }, 100_000);
    if (index.requestId !== lookupId || index.ok !== true)
      throw new Error("Could not list T3 ChatGPT sessions to identify this conversation.");
    const matches = (index.data?.sessions ?? []).filter((item) =>
      item.conversationId === args.conversationId ||
      conversationIdFromUrl(item.observedGuestUrl ?? item.url) === args.conversationId);
    if (matches.length !== 1 || (sessionId && matches[0].id !== sessionId))
      throw new Error("Exact current ChatGPT conversation does not map to ONE T3 session.");
    sessionId = matches[0].id;
  }
  if (!UUID.test(sessionId ?? ""))
    throw new Error("Resolved T3 browser session ID is not canonical.");
  const requestId = args.requestId ?? randomUUID();
  const input = {
    version: 1, requestId, type: "chatgpt.reboot",
    sessionId, phase: args.phase,
    ...(args.phase === "begin" ? { prompt: args.message.trim() } : {}),
  };
  // New T3 protocol omits ChatGPT conversation ID entirely. The renderer
  // resolves the currently attached conversation and persists operation receipt.
  let reply;
  try { reply = await exchange(address, input, 115_000); }
  catch (error) {
    throw new Error("Reboot outcome UNKNOWN; do not repeat begin. " +
      `T3 sessionId=${sessionId} requestId=${requestId}. ` +
      `Use --session-id ${sessionId} --request-id ${requestId} --phase status/finalize. Underlying error: ` +
      String(error?.message ?? error));
  }
  if (reply.requestId !== requestId || reply.version !== 1)
    throw new Error("Reboot response identity mismatch; outcome UNKNOWN for " + requestId);
  if (reply.ok !== true)
    throw new Error("Reboot request " + requestId + " refused or UNKNOWN: " +
      String(reply.message ?? reply.code ?? "unknown"));
  const data = reply.data;
  if (data?.action !== "reboot" || data.sessionId !== sessionId ||
      !Number.isSafeInteger(data.rebootGeneration) || data.rebootGeneration < 1 ||
      !["unknown", "submitted", "committed", "restored"].includes(data.status))
    throw new Error("T3 returned an invalid reboot receipt for request " + requestId);
  return {
    requestId, sessionId, rebootGeneration: data.rebootGeneration,
    status: data.status, retrySafe: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseRebootArgs(process.argv.slice(2));
    if (!args) {
      process.stdout.write("Agent Reboot (OpenRig optional): --session-id UUID or --conversation-url URL; --message-file FILE for begin, --request-id UUID --phase status|finalize to reconcile.\n");
    } else {
      // Print the immutable operation ID BEFORE making any side-effecting request.
      // It remains available even when the desktop acknowledges UNKNOWN.
      args.requestId ??= randomUUID();
      process.stderr.write(`Agent Reboot operation requestId=${args.requestId}; phase=${args.phase}\n`);
      const response = await rebootExistingT3Session(args);
      process.stdout.write(JSON.stringify(response, null, 2) + "\n");
      if (response.status !== "committed") process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(String(error?.message ?? error) + "\n");
    process.exitCode = 1;
  }
}
