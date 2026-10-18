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
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
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

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options === null) {
    process.stdout.write(
      "Usage: node scripts/spawn-chatgpt-session.mjs --title NAME (--message TEXT | --message-file PATH) [--home PATH] [--dry-run]\n",
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
    response = await sendAppControlRequest(address, request);
  } catch (error) {
    throw new Error(
      `Cannot reach the running custom T3 Code app at ${address}. The app must be running with this feature built in. ${error.message}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(`T3 Code rejected the request (${response.code}): ${response.message}`);
  }
  if (!response.messageSent || !response.sessionId) {
    throw new Error("T3 Code did not confirm that ChatGPT received the initial message.");
  }
  process.stdout.write(
    `Created ChatGPT session "${request.title}" (${response.sessionId}); message sent; parent=${response.parentSessionId ?? "none (no explicit caller identity)"}.\n`,
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
