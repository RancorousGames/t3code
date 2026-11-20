import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as DesktopTransport from "../chatgpt-delegation/DesktopTransport.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { desktopSwarmTransports } from "./desktopTransports.ts";
import { swarmForNativeThread, type NativeSwarmInput } from "./nativeAgent.mjs";
import { SwarmToolkit } from "./mcpTools.ts";

const invoke = Effect.fn("SwarmMcp.invoke")(function* (input: NativeSwarmInput) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, "Swarm board");
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const desktop = yield* DesktopTransport.DesktopTransport;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const exchange = (request: Parameters<typeof desktop.exchange>[0]) =>
    runPromise(desktop.exchange(request));
  return yield* Effect.tryPromise({
    try: () =>
      swarmForNativeThread(input, {
        root: path.join(config.baseDir, "swarm"),
        threadId: caller.thread.threadId,
        environmentId: caller.environmentId,
        transports: desktopSwarmTransports(exchange),
      }),
    catch: (cause) =>
      new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});

export const layer = McpToolAccess.toLayer(SwarmToolkit, {
  swarm_read_board: McpToolAccess.readsAsCaller((input) => invoke({ action: "read", ...input })),
  swarm_post_message: McpToolAccess.actsAsCaller((input) => invoke({ action: "post", ...input })),
});
