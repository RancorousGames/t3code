#!/usr/bin/env node
/** Native T3 threads over the running desktop's *existing* Windows named pipe.
 * No OAuth registration, browser approval, pairing, or new listener.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as url from "node:url";
import { controlAddress, sendAppControlRequest } from "./spawn-chatgpt-session.mjs";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function controlNativeThreads(
  input,
  { home = path.resolve(import.meta.dirname, "../.t3"), exchange = sendAppControlRequest } = {},
) {
  if (!input || !["list", "read", "send"].includes(input.action))
    throw new Error("action must be list, read or send");
  if (input.action !== "list" && (typeof input.threadId !== "string" || !UUID.test(input.threadId)))
    throw new Error("threadId must be a native T3 thread UUID");
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
    input.action !== "send" &&
    (input.message !== undefined || input.clientRequestId !== undefined)
  )
    throw new Error("message/clientRequestId apply only to send");
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
    requestId: crypto.randomUUID(),
    type: "t3.threads",
    action: input.action,
    ...(expectedEnvironmentId ? { environmentId: expectedEnvironmentId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.count ? { count: input.count } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") + 1 > 64 * 1024)
    throw new Error("Native thread control request exceeds 64 KiB");
  // A timed-out send may still have executed; never retry or imply it failed.
  const response = await exchange(controlAddress(home), request, 95_000);
  if (response.requestId !== request.requestId || response.version !== 1)
    throw new Error("Desktop response correlation failed");
  if (!response.ok)
    throw new Error("T3 native threads: " + response.code + ": " + response.message);
  if (!Object.hasOwn(response, "data"))
    throw new Error("Running T3 desktop lacks native-thread control. Rebuild/restart T3.");
  if (expectedEnvironmentId && response.data?.environmentId !== expectedEnvironmentId)
    throw new Error("T3 desktop returned the wrong native environment");
  if (
    input.action === "send" &&
    (response.data?.messageSent !== true || response.data?.messageId !== input.clientRequestId)
  )
    throw new Error("T3 native send lacked exact message acknowledgement; do not retry");
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

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
