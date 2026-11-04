#!/usr/bin/env bun
// @effect-diagnostics globalFetch:off -- this bounded Bun-only bridge uses the platform HTTP client.
/**
 * Long-lived authenticated T3 agent-provider/v1 bridge for OmniHub.
 *
 * Configuration is explicit: OMNIHUB_T3_WS_URL (loopback /ws URL),
 * OMNIHUB_T3_AUTH_TOKEN (an independently granted T3 bearer session),
 * OMNIHUB_T3_ENVIRONMENT_ID (exact T3 environment ID).
 *
 * A single Bun process reuses the Effect RPC socket; stdin/stdout is NDJSON.
 * No local named-pipe authority, no browser automation, no child spawns.
 */
import { WsRpcGroup, WS_METHODS, T3_AGENT_PROVIDER_VERSION,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Readline from "node:readline";
import type { WsRpcProtocolClient } from "../../../packages/client-runtime/src/rpc/protocol.ts";

const url = process.env.OMNIHUB_T3_WS_URL;
const token = process.env.OMNIHUB_T3_AUTH_TOKEN;
const environmentId = process.env.OMNIHUB_T3_ENVIRONMENT_ID;
if (!url || !token || !environmentId || !/^wss?:\/\//.test(url)) {
  process.stderr.write("T3 provider v1 requires explicit WS URL, bearer token and environment ID.\n");
  process.exit(2);
}
const candidate = new URL(url);
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(candidate.hostname) ||
    candidate.pathname !== "/ws" || candidate.searchParams.has("wsTicket")) {
  process.stderr.write("T3 provider v1 only accepts the exact loopback /ws endpoint.\n");
  process.exit(2);
}
candidate.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
const socketLayer = Socket.layerWebSocket(candidate.toString(), { openTimeout: "10 seconds" }).pipe(
  Layer.provide(Layer.succeed(
    Socket.WebSocketConstructor,
    (address: string) => new WebSocket(address, {
      headers: { Authorization: "Bearer " + token },
    }),
  )),
);
const transport = Layer.effect(
  RpcClient.Protocol,
  RpcClient.makeProtocolSocket({
    pingTimeout: "15 seconds",
    retryTransientErrors: false,
    retryPolicy: Schedule.recurs(0),
  }),
).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));

type Client = WsRpcProtocolClient;
async function serve(client: Client, lines: AsyncIterator<string>): Promise<boolean> {
while (true) {
  const next = await lines.next();
  if (next.done) return false;
  const line = next.value;
  let id: string | undefined;
  try {
    const message = JSON.parse(line);
    id = message.id;
    if (typeof id !== "string" || !id || typeof message.method !== "string" ||
        typeof message.params !== "object" || message.params === null)
      throw new Error("Invalid bounded provider request");
    if (message.method === "sessions.history" &&
        typeof message.params.session === "object" &&
        message.params.session?.id?.startsWith("thread:")) {
      try {
        const data = await nativeHistoryFromHttp(message.params);
        process.stdout.write(JSON.stringify({
          id, result: { apiVersion: T3_AGENT_PROVIDER_VERSION,
            requestId: id, ok: true, data },
        }) + "\n");
      } catch {
        process.stdout.write(JSON.stringify({
          id, result: { apiVersion: T3_AGENT_PROVIDER_VERSION,
            requestId: id, ok: false,
            error: { code: "Unavailable", message: "Native history HTTP read failed",
              retryable: true } },
        }) + "\n");
      }
      continue;
    }    const rpcResult = await Effect.runPromise(client[WS_METHODS.agentProviderCall]({
      apiVersion: T3_AGENT_PROVIDER_VERSION,
      requestId: id,
      method: message.method,
      params: message.params,
    }));
    process.stdout.write(JSON.stringify({ id, result: rpcResult }) + "\n");
  } catch (error) {
    // Never log URL ticket, token, source text or project content to stdout.
    process.stdout.write(JSON.stringify({
      id: id ?? null,
      // Expose only a sanitized exception class/shape for Hub diagnostics.
      // Never include error messages, stacks, request contents or credentials.
      error: error instanceof Error ? error.name :
        typeof error === "object" && error !== null ?
          (typeof (error as { _tag?: unknown })._tag === "string" ?
            (error as { _tag: string })._tag :
            typeof (error as { name?: unknown }).name === "string" ?
              (error as { name: string }).name :
              `Unclassified_${Object.keys(error).filter(key => /^[A-Za-z_]{1,32}$/.test(key)).slice(0,4).join("_")}`) :
          "ConnectionUnavailable",
    }) + "\n");
    // A stale WS can fail after hours of idle time. Dispose and replace the
    // authenticated socket for the NEXT input only; never replay this one.
    return true;
  }
}
}
/** Native thread history is already available from T3's bounded authenticated
 * HTTP API. Its WS provider RPC currently drops the connection on real timelines. */
async function nativeHistoryFromHttp(params: Record<string, unknown>) {
  const session = params.session as { provider?: string; id?: string } | undefined;
  if (session?.provider !== "t3" || !session.id?.startsWith("thread:") ||
      params.expectedEnvironmentId !== environmentId)
    throw new Error("Invalid native history session/environment");
  const rawId = decodeURIComponent(session.id.slice("thread:".length));
  if (!rawId || encodeURIComponent(rawId) !== session.id.slice("thread:".length))
    throw new Error("Invalid native thread identity");
  const cursor = typeof params.cursor === "string" && params.cursor
    ? params.cursor
    : Buffer.from(JSON.stringify({
      v: 1, seq: 0, st: rawId, si: "provider-http-history-start",
      p: Number.MAX_SAFE_INTEGER,
    })).toString("base64url");
  const endpoint = new URL(candidate.toString());
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = "/api/orchestration/threads/" + encodeURIComponent(rawId) + "/history";
  endpoint.search = "";
  endpoint.searchParams.set("cursor", cursor);
  endpoint.searchParams.set("view", "conversation");
  const response = await fetch(endpoint, {
    headers: {
      Authorization: "Bearer " + token,
      "x-t3-orchestration-protocol": String(ORCHESTRATION_PROTOCOL_VERSION),
    },
    signal: AbortSignal.timeout(16_000),
  });
  if (!response.ok) throw new Error("Native history HTTP status " + response.status);
  const page = await response.json() as {
    items: Array<{ sourceThreadId: string; sourceItemId: string; visibility: string;
      item: { type: string; text?: string; markdown?: string; updatedAt?: string;
        streaming?: boolean } }>;
    snapshotSequence: number; nextCursor: string | null; hasMoreHistory: boolean;
  };
  if (!Array.isArray(page.items) || typeof page.snapshotSequence !== "number")
    throw new Error("Invalid native history API response");
  return {
    items: page.items.map((row) => {
      const item = row.item;
      const text = typeof item.text === "string" ? item.text
        : typeof item.markdown === "string" ? item.markdown : null;
      return {
        id: "turn:" + encodeURIComponent(row.sourceThreadId) + ":" +
          encodeURIComponent(row.sourceItemId),
        revision: page.snapshotSequence,
        kind: item.type,
        at: item.updatedAt ?? null,
        author: item.type === "user_message" ? "user"
          : item.type === "assistant_message" ? "assistant" : "native",
        parts: [
          ...(text === null ? [] : [{ type: "text", text }]),
          { type: "native.turn_item", sourceThreadId: row.sourceThreadId,
            sourceItemId: row.sourceItemId, visibility: row.visibility, item },
        ],
        streaming: item.streaming === true,
        completeness: item.streaming === true ? "Partial" : "Full",
      };
    }),
    older: page.nextCursor, newer: null, complete: !page.hasMoreHistory,
    snapshotSequence: page.snapshotSequence,
  };
}
const lineReader = Readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const input = lineReader[Symbol.asyncIterator]();
while (true) {
  const reconnect = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    return yield* Effect.promise(() => serve(client, input));
  }).pipe(Effect.provide(transport)))).catch(() => true);
  if (!reconnect) break;
  await Effect.runPromise(Effect.sleep("350 millis")); // socket only; never replay a prompt
}
