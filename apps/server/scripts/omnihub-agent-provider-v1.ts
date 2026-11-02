#!/usr/bin/env bun
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
    const rpcResult = await Effect.runPromise(client[WS_METHODS.agentProviderCall]({
      apiVersion: T3_AGENT_PROVIDER_VERSION,
      requestId: id,
      method: message.method,
      params: message.params,
    }));
    process.stdout.write(JSON.stringify({ id, result: rpcResult }) + "\n");
  } catch (error) {
    // Never log URL ticket, token, source text or project content to stdout.
    process.stdout.write(JSON.stringify({
      id: id ?? null, error: error instanceof Error ? error.name : "ConnectionUnavailable",
    }) + "\n");
    // A stale WS can fail after hours of idle time. Dispose and replace the
    // authenticated socket for the NEXT input only; never replay this one.
    return true;
  }
}
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
