import { AuthMcpClientAccess, EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as GlobalFlag from "effect/cli/GlobalFlag";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Links live in this environment's database and secret store, so these
 * commands work whether or not its server is running.
 */
const runWithPeerLinks = Effect.fn("environment.runWithPeerLinks")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (links: PeerLinks.PeerLinks["Service"]) => Effect.Effect<A, E>,
  options?: { readonly quietLogs?: boolean },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  return yield* PeerLinks.PeerLinks.pipe(
    Effect.flatMap(run),
    Effect.provide(
      PeerLinks.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSecretStore.layer,
            SqlitePersistence.layerConfig,
            FetchHttpClient.layer,
          ),
        ),
        Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        Layer.provide(
          ServerSettings.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                ServerSecretStore.layer,
                SqlitePersistence.layerConfig,
                ManagedPolicy.layer,
              ),
            ),
          ),
        ),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(
          Layer.succeed(References.MinimumLogLevel, options?.quietLogs ? "Error" : config.logLevel),
        ),
      ),
    ),
  );
});

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const encodeLinks = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.toEncoded(Schema.Unknown))),
);

const formatLinks = (links: ReadonlyArray<PeerLinkSummary>) =>
  links.length === 0
    ? "No linked environments.\n"
    : `${links
        .map(
          (link) =>
            `${link.label} (${link.environmentId})\n  ${link.status}, access ${link.access}, expires ${DateTime.formatIso(link.expiresAt)}\n  ${link.urls.join(", ")}${link.lastError === null ? "" : `\n  last error: ${link.lastError}`}`,
        )
        .join("\n\n")}\n`;

const environmentLinkCommand = Command.make("link", {
  ...authLocationFlags,
  url: Argument.String("url").pipe(
    Argument.withDescription(
      "Where the other environment answers: its T3 Connect, Tailscale, LAN or loopback address.",
    ),
  ),
  alternateUrl: Flag.String("url").pipe(
    Flag.withDescription("Another address for the same environment, tried after the first."),
    Flag.atLeast(0),
  ),
  pairingCode: Flag.String("pairing-code").pipe(
    Flag.withDescription("A pairing code from the other environment (`t3 pair` there)."),
  ),
  access: Flag.Literals("access", AuthMcpClientAccess.literals).pipe(
    Flag.withDescription(
      "What this environment's agents may do there: read-only, or the broadest runtime mode.",
    ),
    Flag.withDefault("approval-required" as const),
  ),
}).pipe(
  Command.withDescription(
    "Link another T3 Code environment, so agents here can work there. It shows up there under Settings → Connections, where it can be revoked.",
  ),
  Command.withHandler((flags) =>
    runWithPeerLinks(flags, (links) =>
      Effect.gen(function* () {
        const linked = yield* links.link({
          url: flags.url,
          alternateUrls: flags.alternateUrl,
          pairingCode: flags.pairingCode,
          access: flags.access,
        });
        yield* Console.log(
          `Linked ${linked.label} (${linked.environmentId}) with ${linked.access} access, until ${DateTime.formatIso(linked.expiresAt)}.\n`,
        );
      }),
    ),
  ),
);

const environmentListCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List linked environments and whether each answers now."),
  Command.withHandler((flags) =>
    runWithPeerLinks(
      flags,
      (links) =>
        Effect.gen(function* () {
          const listed = yield* links.list;
          yield* Console.log(flags.json ? `${yield* encodeLinks(listed)}\n` : formatLinks(listed));
        }),
      { quietLogs: flags.json },
    ),
  ),
);

const environmentUnlinkCommand = Command.make("unlink", {
  ...authLocationFlags,
  environmentId: Argument.String("environment-id").pipe(
    Argument.withDescription("The linked environment's id, from `t3 environment list`."),
  ),
}).pipe(
  Command.withDescription(
    "Forget a linked environment here. Revoke it in that environment's Connections to end its session there too.",
  ),
  Command.withHandler((flags) =>
    runWithPeerLinks(flags, (links) =>
      Effect.gen(function* () {
        const removed = yield* links.unlink(EnvironmentId.make(flags.environmentId));
        yield* Console.log(
          removed
            ? `Forgot ${flags.environmentId}. Revoke it in that environment's Connections to end its session there.\n`
            : `No linked environment ${flags.environmentId}.\n`,
        );
      }),
    ),
  ),
);

const remoteUpdateResult = Schema.Struct({
  state: Schema.Literals(["queued", "running", "succeeded", "failed"]),
  startedAt: Schema.String,
  finishedAt: Schema.optional(Schema.String),
  message: Schema.String,
  logPath: Schema.String,
});

const remoteUpdate = (tool: "t3_environment_update_wife" | "t3_environment_update_wife_status") =>
  Command.make(tool === "t3_environment_update_wife" ? "update-wife" : "update-wife-status", {
    ...authLocationFlags,
    environmentId: Argument.String("environment-id"),
    json: jsonFlag,
  }).pipe(
    Command.withDescription(
      tool === "t3_environment_update_wife"
        ? "Explicitly start T3 + Mori update on a linked Windows PC."
        : "Get durable T3 + Mori remote update status.",
    ),
    Command.withHandler((flags) =>
      runWithPeerLinks(
        flags,
        (links) =>
          Effect.gen(function* () {
            const client = yield* PeerMcpClient.PeerMcpClient;
            const result = yield* client.call({
              environmentId: EnvironmentId.make(flags.environmentId),
              tool,
              arguments: {},
              limits: { runtimeMode: "full-access", interactionMode: "default" },
              success: remoteUpdateResult,
            });
            yield* Console.log(
              flags.json
                ? `${yield* Schema.encodeEffect(Schema.fromJsonString(remoteUpdateResult))(result)}\n`
                : `${result.state}: ${result.message} (log: ${result.logPath})\n`,
            );
          }).pipe(
            Effect.provide(
              PeerMcpClient.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(PeerLinks.PeerLinks, links),
                    FetchHttpClient.layer,
                  ),
                ),
              ),
            ),
          ),
        { quietLogs: flags.json },
      ),
    ),
  );

export const environmentCommand = Command.make("environment").pipe(
  Command.withDescription("Link other T3 Code environments, so agents here can work there."),
  Command.withSubcommands([
    environmentLinkCommand,
    environmentListCommand,
    environmentUnlinkCommand,
    remoteUpdate("t3_environment_update_wife"),
    remoteUpdate("t3_environment_update_wife_status"),
  ]),
);
