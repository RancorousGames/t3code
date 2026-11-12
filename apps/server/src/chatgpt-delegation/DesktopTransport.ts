// @effect-diagnostics nodeBuiltinImport:off -- Adapter for the desktop's local control socket.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import { type DesktopAppActivationRequest } from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Registry from "../chatGPTSessionRegistry.ts";

export class DesktopTransportError extends Schema.TaggedError<DesktopTransportError>()(
  "ChatGPTDelegationDesktopError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The ChatGPT desktop operation could not be confirmed.";
  }
}

const Reply = Schema.Struct({
  version: Schema.Literal(1),
  requestId: Schema.String,
  ok: Schema.Boolean,
  data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeReply = Schema.decodeUnknownEffect(Reply);

export class DesktopTransport extends Context.Service<
  DesktopTransport,
  {
    readonly available: Effect.Effect<boolean>;
    readonly findSpawn: (requestId: string) => Effect.Effect<string | null, DesktopTransportError>;
    readonly exchange: (
      request: DesktopAppActivationRequest,
    ) => Effect.Effect<Record<string, unknown>, DesktopTransportError>;
    readonly stop: (
      sessionId: string,
      conversationId: string,
    ) => Effect.Effect<void, DesktopTransportError>;
  }
>()("t3/chatgpt-delegation/DesktopTransport") {}

const make = Effect.gen(function* () {
  const config = yield* Config.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;
  const path = yield* Path.Path;
  const environment = yield* Environment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const registry = yield* Registry.ChatGPTSessionRegistry;
  const address = resolveDesktopAppControlAddress({
    stateDir: config.stateDir,
    platform,
    userId,
    tempDir: NodeOS.tmpdir(),
    joinPath: path.join,
  }).address;
  const exchange = Effect.fn("ChatGPTDelegation.DesktopTransport.exchange")(function* (
    request: DesktopAppActivationRequest,
  ) {
    const raw = yield* Effect.callback<unknown, DesktopTransportError>((resume) => {
      const socket = NodeNet.createConnection(address);
      let buffer = "";
      const fail = (cause: unknown) => resume(Effect.fail(new DesktopTransportError({ cause })));
      socket.setEncoding("utf8");
      socket.setTimeout(110_000, () => fail(new Error("Desktop response deadline")));
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) {
          fail(new Error("Oversized desktop response"));
          return;
        }
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        try {
          resume(Effect.succeed(JSON.parse(buffer.slice(0, end))));
        } catch (cause) {
          fail(cause);
        }
      });
      socket.once("error", fail);
      socket.once("end", () => fail(new Error("Desktop disconnected")));
      return Effect.sync(() => socket.destroy());
    });
    const reply = yield* decodeReply(raw).pipe(
      Effect.mapError((cause) => new DesktopTransportError({ cause })),
    );
    if (reply.requestId !== request.requestId || !reply.ok || !reply.data)
      return yield* new DesktopTransportError({ cause: raw });
    return reply.data;
  });
  return DesktopTransport.of({
    available: registry.driver(environmentId).pipe(
      Effect.map((driver) => driver.online),
      Effect.orElseSucceed(() => false),
    ),
    findSpawn: Effect.fn("ChatGPTDelegation.DesktopTransport.findSpawn")(function* (requestId) {
      const sessions = yield* registry
        .list(environmentId)
        .pipe(Effect.mapError((cause) => new DesktopTransportError({ cause })));
      const matches = sessions.filter(
        (session) => session.record.spawnRequestId === requestId && session.closedAt === null,
      );
      return matches.length === 1 ? matches[0]!.sessionId : null;
    }),
    exchange,
    stop: Effect.fn("ChatGPTDelegation.DesktopTransport.stop")(
      function* (sessionId, conversationId) {
        const result = yield* exchange({
          version: 1,
          requestId: `chatgpt-stop:${sessionId}`,
          type: "chatgpt.sessions",
          action: "stop",
          sessionId,
          expectedConversationId: conversationId,
        });
        if (result.stopped !== true) return yield* new DesktopTransportError({ cause: result });
      },
    ),
  });
});

export const layer = Layer.effect(DesktopTransport, make).pipe(Layer.provide(Registry.layer));
