#!/usr/bin/env node
/** One local-only human inbox control entrypoint, using the existing T3 named pipe. */
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { controlAddress, sendAppControlRequest } from "./spawn-chatgpt-session.mjs";

const actions = ["fetch_unread", "fetch_recent_read", "set_state", "reply"];
const sources = ["queue", "mailbox", "human_gate"];
const states = ["read", "unread", "archived", "trash", "inbox"];

export async function controlHumanInbox(input, {
  exchange = sendAppControlRequest,
  home = NodePath.resolve(import.meta.dirname, "../.t3"),
} = {}) {
  if (!input || typeof input !== "object" || !actions.includes(input.action))
    throw new Error("action must be fetch_unread, fetch_recent_read, set_state or reply.");
  if (input.address !== undefined &&
      (typeof input.address !== "string" || !input.address.trim() || input.address.length > 160))
    throw new Error("Invalid human inbox address.");
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50))
    throw new Error("limit must be 1..50.");
  if (["set_state", "reply"].includes(input.action) &&
      (typeof input.itemId !== "string" || !input.itemId.trim() ||
       input.itemId.length > 200 || !sources.includes(input.sourceType)))
    throw new Error("set_state and reply require exact itemId and sourceType.");
  if (input.action === "set_state" ? !states.includes(input.state) : input.state !== undefined)
    throw new Error("state=read,unread,archived,trash,inbox is valid only for set_state.");
  if (input.action === "reply" ?
    !Array.isArray(input.answers) || input.answers.length < 1 || input.answers.length > 8 :
    input.answers !== undefined)
    throw new Error("reply requires 1..8 structured answers; other actions cannot send replies.");
  if (input.message !== undefined)
    throw new Error("Plain-text reply transport is not available; only structured v2 answers can be submitted.");
  const request = {
    version: 1, requestId: NodeCrypto.randomUUID(), type: "openrig.human_inbox",
    action: input.action,
    ...(input.address ? { address: input.address } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.sourceType ? { sourceType: input.sourceType } : {}),
    ...(input.state ? { state: input.state } : {}),
    ...(input.answers ? { answers: input.answers } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(request), "utf8") > 16_000)
    throw new Error("Human inbox request exceeds 16 KiB.");
  const response = await exchange(controlAddress(home), request, 95_000);
  if (!response.ok)
    throw new Error(`T3 human inbox rejected ${input.action}: ${response.code}: ${response.message}`);
  if (!response.data || response.data.action !== input.action)
    throw new Error("T3 did not return a matching human inbox action receipt; update the desktop app.");
  if (["set_state", "reply"].includes(input.action) &&
      (response.data.itemId !== input.itemId || response.data.sourceType !== input.sourceType ||
        (input.action === "set_state" &&
          (response.data.state !== input.state || response.data.persisted !== true)) ||
        (input.action === "reply" && response.data.acceptedIntoQueue !== true)))
    throw new Error("T3 did not confirm exact human inbox target and durable/local persistence.");
  return response.data;
}

export async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/u, ""));
  const data = await controlHumanInbox(input);
  process.stdout.write(JSON.stringify(data) + "\n");
}

if (process.argv[1] && NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
