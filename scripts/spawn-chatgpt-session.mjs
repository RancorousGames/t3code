#!/usr/bin/env node
/**
 * Open a named ChatGPT browser session in the running custom T3 Code desktop app
 * and send its first message via T3's existing, local-only app control socket.
 *
 * Example:
 *   node scripts/spawn-chatgpt-session.mjs --title "Review combat" --message "Review D43."
 *   node scripts/spawn-chatgpt-session.mjs --title "Review combat" --message-file task.md
 *
 * Does not launch another T3 instance or require a ChatGPT API key.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const ROOT = NodePath.resolve(import.meta.dirname, "..");

export function parseArguments(args) {
  const options = {
    home: NodePath.join(ROOT, ".t3"),
    title: "",
    message: "",
    messageFile: "",
    parentSessionId: "",
    project: "",
    requireParent: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--require-parent") {
      options.requireParent = true;
    } else if (
      arg === "--title" ||
      arg === "--message" ||
      arg === "--message-file" ||
      arg === "--parent-session-id" ||
      arg === "--project" ||
      arg === "--home"
    ) {
      if (i + 1 >= args.length) throw new Error(`Missing value for ${arg}.`);
      options[
        arg === "--message-file"
          ? "messageFile"
          : arg === "--parent-session-id"
            ? "parentSessionId"
            : arg.slice(2)
      ] = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      return null;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.title.trim()) throw new Error("A nonempty --title is required.");
  if (options.message && options.messageFile)
    throw new Error("Choose --message or --message-file, not both.");
  if (options.messageFile)
    options.message = NodeFS.readFileSync(NodePath.resolve(options.messageFile), "utf8");
  if (!options.message.trim())
    throw new Error("A nonempty --message or --message-file is required.");
  // The named pipe cannot identify the calling ChatGPT guest. Agents creating
  // actual child sessions should opt into fail-closed mode rather than silently
  // opening a root when their tool transport failed to carry provenance.
  if (options.requireParent && !options.parentSessionId.trim())
    throw new Error(
      "--require-parent needs an explicit --parent-session-id (T3 browser UUID). The desktop pipe cannot infer the caller.",
    );
  return options;
}

export function controlAddress(home) {
  const stateDir = NodePath.resolve(home, "userdata");
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 24);
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone Node CLI entrypoint, not an Effect service.
  if (process.platform !== "win32")
    throw new Error("This prototype currently supports Windows only.");
  return `\\\\.\\pipe\\t3code-app-${hash}`;
}

export function sendAppControlRequest(address, request, timeoutMs = 100_000) {
  return new Promise((resolveResponse, reject) => {
    const client = NodeNet.createConnection(address);
    let settled = false;
    let received = "";
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      client.destroy();
      if (error) reject(error);
      else resolveResponse(response);
    };
    client.setTimeout(timeoutMs, () =>
      finish(new Error("Timed out while waiting for T3 Code to send the message.")),
    );
    client.once("error", (error) => finish(error));
    client.on("connect", () => client.write(`${JSON.stringify(request)}\n`));
    client.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (Buffer.byteLength(received, "utf8") > 2 * 1024 * 1024)
        return finish(new Error("Unexpectedly large T3 Code response."));
      const end = received.indexOf("\n");
      if (end !== -1) {
        try {
          const response = JSON.parse(received.slice(0, end));
          if (response.requestId !== request.requestId || response.version !== 1) {
            return finish(new Error("Invalid desktop response correlation."));
          }
          finish(null, response);
        } catch (error) {
          finish(error);
        }
      }
    });
    client.once("end", () =>
      finish(new Error("T3 Code closed the connection without responding.")),
    );
  });
}

export function createChatGPTSpawnRequest(options, requestId = NodeCrypto.randomUUID()) {
  return {
    version: 1,
    requestId,
    type: "chatgpt.spawn",
    title: options.title.trim(),
    prompt: options.message,
    ...(options.parentSessionId.trim() ? { parentSessionId: options.parentSessionId.trim() } : {}),
    ...(options.project.trim() ? { project: options.project.trim() } : {}),
  };
}

// Parent identity must be confirmed by a T3 response or read-only stored-session
// lookup. The request's parent ID alone is not evidence that it was attached.
export function observedSpawnParent(request, session, observed) {
  const parentSessionId = observed ? (session?.parentSessionId ?? null) : null;
  const expected = request.parentSessionId;
  return {
    parentSessionId,
    ...(expected ? { requestedParentSessionId: expected } : {}),
    parentConfirmation: !expected
      ? "not_requested"
      : !observed
        ? "unconfirmed"
        : parentSessionId === expected
          ? "confirmed"
          : "mismatch",
  };
}

// A lost activation response cannot be retried: the renderer may already have
// persisted a session and clicked Send. Correlate ONLY via a read-only list.
export async function reconcileCreatedSpawn(address, request, exchange = sendAppControlRequest) {
  let matchedSession = null;
  let lookupError = null;
  try {
    const listed = await exchange(
      address,
      {
        version: 1,
        requestId: NodeCrypto.randomUUID(),
        type: "chatgpt.sessions",
        action: "list",
        which: "all",
        includeHidden: true,
      },
      20_000,
    );
    if (listed.ok && Array.isArray(listed.data?.sessions)) {
      const matches = listed.data.sessions.filter(
        (session) =>
          session.spawnRequestId === request.requestId &&
          typeof session.id === "string" &&
          session.id.length > 0,
      );
      if (matches.length === 1) matchedSession = matches[0];
    }
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }
  const sessionId = matchedSession?.id ?? null;
  return {
    requestId: request.requestId,
    outcome: sessionId ? "created" : "unknown",
    created: sessionId ? true : null,
    sessionId,
    ...observedSpawnParent(
      request,
      matchedSession,
      matchedSession !== null && Object.hasOwn(matchedSession, "parentSessionId"),
    ),
    messageSent: false,
    promptDelivery: "unknown",
    sendAttempted: null,
    reconciliation: sessionId ? "read_only_list_correlation" : "unconfirmed",
    ...(lookupError ? { lookupError } : {}),
    next: "Inspect the exact session with chatgpt.sessions read/list; do not spawn or send again automatically.",
  };
}

export function classifySpawnResponse(response, request) {
  if (!response.ok) {
    if (
      response.code === "chatgpt-send-failed" ||
      (["request-timeout", "renderer-unavailable"].includes(response.code) &&
        /UNKNOWN/i.test(response.message ?? ""))
    )
      return null;
    throw new Error(`T3 Code rejected the request (${response.code}): ${response.message}`);
  }
  if (
    response.messageSent === true &&
    typeof response.sessionId === "string" &&
    response.sessionId.length > 0
  ) {
    return {
      requestId: request.requestId,
      outcome: "delivered",
      created: true,
      sessionId: response.sessionId,
      messageSent: true,
      promptDelivery: "user_turn_observed",
      sendAttempted: true,
      ...observedSpawnParent(request, response, Object.hasOwn(response, "parentSessionId")),
    };
  }
  const data = response.data;
  if (
    data?.action === "spawn" &&
    data.created === true &&
    typeof data.sessionId === "string" &&
    data.sessionId.length > 0 &&
    ["unknown", "not_sent"].includes(data.promptDelivery) &&
    data.messageSent === false
  ) {
    return {
      requestId: request.requestId,
      outcome: "created",
      created: true,
      sessionId: data.sessionId,
      ...observedSpawnParent(request, data, Object.hasOwn(data, "parentSessionId")),
      messageSent: false,
      promptDelivery: data.promptDelivery,
      sendAttempted: data.sendAttempted ?? null,
      ...(data.reason ? { reason: data.reason } : {}),
      next: "Inspect exact session with chatgpt.sessions read/list before any manual decision; do not automatically resend.",
    };
  }
  throw new Error("T3 Code did not provide a valid ChatGPT initial prompt delivery receipt.");
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options === null) {
    process.stdout.write(
      "Usage: node scripts/spawn-chatgpt-session.mjs --title NAME (--message TEXT | --message-file PATH) [--parent-session-id T3_BROWSER_UUID] [--require-parent] [--project NAME] [--home PATH] [--dry-run]\n",
    );
    return;
  }
  const request = createChatGPTSpawnRequest(options);
  const address = controlAddress(options.home);
  if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > 64 * 1024) {
    throw new Error("Message exceeds the desktop control socket's 64 KiB request limit.");
  }
  if (options.dryRun) {
    process.stdout.write(JSON.stringify({ address, request }, null, 2) + "\n");
    return;
  }
  let response;
  try {
    // Leave time for one read-only lookup under OmniHub's 115s process deadline.
    response = await sendAppControlRequest(address, request, 90_000);
  } catch {
    // The renderer may already have accepted this request. Never replay it.
  }
  const receipt = response ? classifySpawnResponse(response, request) : null;
  process.stdout.write(
    JSON.stringify(receipt ?? (await reconcileCreatedSpawn(address, request))) + "\n",
  );
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
