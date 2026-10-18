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
  const allowed = ["list", "read", "send", "reload"];
  if (!input || !allowed.includes(input.action))
    throw new Error("action must be list, read, send or reload.");
  if (
    input.which !== undefined &&
    (input.action !== "list" ||
      !["visible", "recent", "working", "blocked", "all"].includes(input.which))
  )
    throw new Error(
      "which applies only to list and must be visible, recent, working, blocked or all.",
    );
  if (input.action !== "list" && !(typeof input.sessionId === "string" && input.sessionId.trim()))
    throw new Error("sessionId is required for read, send and reload.");
  if (input.action === "send" && !(typeof input.message === "string" && input.message.trim()))
    throw new Error("Nonempty message required for send.");
  const request = {
    version: 1,
    requestId: NodeCrypto.randomUUID(),
    type: "chatgpt.sessions",
    action: input.action,
    ...(input.action === "list" ? { which: input.which ?? "visible" } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.from ? { from: input.from } : {}),
    ...(input.count !== undefined ? { count: input.count } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.force !== undefined ? { force: input.force } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > 64 * 1024)
    throw new Error("Request exceeds the 64 KiB desktop limit.");
  const response = await exchange(controlAddress(home), request, 95_000);
  if (!response.ok)
    throw new Error(`T3 Code rejected ${input.action}: ${response.code}: ${response.message}`);
  if (!Object.hasOwn(response, "data"))
    throw new Error(
      "T3 Code did not return session data. Rebuild and restart the updated desktop app.",
    );
  return response.data;
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
