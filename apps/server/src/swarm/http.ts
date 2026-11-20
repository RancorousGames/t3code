import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as DesktopTransport from "../chatgpt-delegation/DesktopTransport.ts";
import { runSwarm } from "./index.mjs";

const noStore = { "cache-control": "no-store" };
const reply = (data: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(data, { status, headers: noStore });

/** Opt-in Swarm RPC. This is the only server integration point. */
export const layer = HttpRouter.add(
  "POST",
  "/api/swarm",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateBrowserSession(request).pipe(Effect.result);
    if (Result.isFailure(session)) return reply({ error: "Browser session required." }, 401);

    const decoded = yield* request.json.pipe(Effect.result);
    if (
      Result.isFailure(decoded) ||
      !decoded.success ||
      typeof decoded.success !== "object" ||
      Array.isArray(decoded.success)
    )
      return reply({ error: "Expected a JSON Swarm request object." }, 400);

    const input = decoded.success as Record<string, unknown>;
    const write = !["list", "read", "delivery"].includes(input.action as string);
    const scope = write ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope;
    if (!session.success.scopes.includes(scope))
      return reply({ error: "Swarm permission unavailable for this session." }, 403);

    // The desktop already owns both transports and the durable ChatGPT retry queue.
    // The HTTP entrypoint injects that *existing* named-pipe bridge so bundled
    // servers never depend on unbundled scripts or create another sender.
    const desktop = yield* DesktopTransport.DesktopTransport;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const exchange = (request: Parameters<typeof desktop.exchange>[0]) =>
      runPromise(desktop.exchange(request));
    const transports = {
      native: async (call: Record<string, unknown>) => {
        const result = await exchange({
          version: 1,
          requestId: String(call.clientRequestId),
          type: "t3.threads",
          action: "send",
          threadId: String(call.threadId),
          ...(call.expectedEnvironmentId
            ? { environmentId: String(call.expectedEnvironmentId) }
            : {}),
          clientRequestId: String(call.clientRequestId),
          message: String(call.message),
        });
        return result;
      },
      chatgpt: async (call: Record<string, unknown>) =>
        call.action === "delivery_status"
          ? exchange({
              version: 1,
              requestId: `swarm-delivery-status:${String(call.messageId)}`,
              type: "chatgpt.sessions",
              action: "delivery_status",
              messageId: String(call.messageId),
            })
          : exchange({
              version: 1,
              requestId: String(call.messageId),
              type: "chatgpt.sessions",
              action: "enqueue",
              messageId: String(call.messageId),
              sessionId: String(call.sessionId),
              expectedConversationId: String(call.expectedConversationId),
              message: String(call.message),
            }),
    };
    const result = yield* Effect.tryPromise({
      try: () =>
        runSwarm(
          {
            ...input,
            action: String(input.action),
            // Browser sessions represent the human operator, not an agent.
            // Never let a crafted browser request impersonate a swarm member.
            ...(input.action === "post" ? { author: "human" } : {}),
          },
          {
            root: path.join(config.baseDir, "swarm"),
            enabled: write && input.enabled === true,
            transports,
          },
        ),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(Effect.result);
    return Result.isSuccess(result) ? reply(result.success) : reply({ error: result.failure }, 400);
  }),
);
