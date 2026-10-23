import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const parentThreadId = ThreadId.make("thread:spawn-approval-parent");
const codex = ProviderInstanceId.make("codex");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:spawn-approval"),
  requestNamespace: "provider-session:spawn-approval",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:spawn-approval",
    providerInstanceId: codex,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

// These targets are ready: denial must come from the interim spawn hold,
// rather than an unavailable provider, inactive parent or runtime-mode limit.
const targets = [
  { providerInstanceId: codex, model: "gpt-6-astra" },
  { providerInstanceId: codex, model: "gpt-5.6-luna" },
  { providerInstanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  { providerInstanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-4-6" },
  { providerInstanceId: codex, model: "gpt-6-luna" },
  { providerInstanceId: codex, model: "gpt-6-luna-spoof" },
  { providerInstanceId: ProviderInstanceId.make("unknown"), model: "unknown" },
] as const;

const withService = Effect.sync(() => {
  const dispatched: string[] = [];
  const parent = {
    ...idleThreadProjection(liveThreadShell(parentThreadId)),
    runs: [
      {
        id: RunId.make("run:spawn-approval-parent"),
        ordinal: 1,
        status: "running",
        rootNodeId: NodeId.make("node:spawn-approval-parent"),
        providerInstanceId: codex,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const providers: ServerProvider[] = [codex, ProviderInstanceId.make("claudeAgent")].map(
    (instanceId) => ({
      instanceId,
      driver: ProviderDriverKind.make(instanceId),
      enabled: true,
      installed: true,
      version: "test",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-19T00:00:00.000Z",
      models: targets
        .filter((target) => target.providerInstanceId === instanceId)
        .map(({ model }) => ({ slug: model, name: model, isCustom: false, capabilities: null })),
      slashCommands: [],
      skills: [],
    }),
  );
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(parent),
      hasReceipt: () => Effect.succeed(false),
      assertProviderInstanceEnabled: () => Effect.void,
      isProviderInstanceEnabledForProject: () => Effect.succeed(true),
      dispatch: (command) =>
        Effect.sync(() => dispatched.push(command.type)).pipe(
          Effect.andThen(Effect.die("Unapproved spawn reached orchestration dispatch")),
        ),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed(providers.map(({ instanceId }) => instanceId)),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  );
  return {
    dispatched,
    layer: OrchestratorMcpService.layer.pipe(Layer.provide(dependencies)),
  };
});

describe("MCP create_threads interim spawn approval hold", () => {
  it.effect.each(targets)("denies $providerInstanceId:$model before dispatch", (target) =>
    Effect.gen(function* () {
      const harness = yield* withService;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .createThreads(scope, {
            clientRequestId: "spawn-hold-single",
            threads: [{ target, prompt: "Must not start a provider session." }],
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "capability_denied");
        assert.include(error.message, "human spawn approval");
        assert.deepEqual(harness.dispatched, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("denies inherited targets, promptless creates and unverified callers", () =>
    Effect.gen(function* () {
      const harness = yield* withService;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        for (const caller of [scope, { ...scope, thread: undefined }]) {
          const error = yield* service.createThreads(caller, { threads: [{}] }).pipe(Effect.flip);
          assert.equal(error.code, "capability_denied");
        }
        assert.deepEqual(harness.dispatched, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("ignores claimed human approval and refuses every batch/retry concurrently", () =>
    Effect.gen(function* () {
      const harness = yield* withService;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const input = {
          clientRequestId: "spawn-hold-replayed-batch",
          approved: true,
          isHuman: true,
          createdBy: "user",
          userId: "operator",
          approvalToken: "agent-supplied-token",
          threads: targets.map((target) => ({
            target,
            prompt: "Must not create a child.",
            runtimeMode: "approval-required" as const,
          })),
        };
        const errors = yield* Effect.forEach(
          [0, 1],
          () => service.createThreads(scope, input).pipe(Effect.flip),
          { concurrency: "unbounded" },
        );
        assert.deepEqual(
          errors.map(({ code }) => code),
          ["capability_denied", "capability_denied"],
        );
        assert.deepEqual(harness.dispatched, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("MCP delegate_task interim spawn approval hold", () => {
  it.effect.each(targets)(
    "denies delegation to $providerInstanceId:$model without dispatch",
    (target) =>
      Effect.gen(function* () {
        const harness = yield* withService;
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const input = {
            clientRequestId: "delegate-hold",
            target,
            task: "No child may start.",
            mode: "async",
          } satisfies Parameters<typeof service.delegateTask>[1];
          const error = yield* service.delegateTask(scope, input).pipe(Effect.flip);
          assert.equal(error.code, "capability_denied");
          assert.include(error.message, "human spawn approval");
          assert.deepEqual(harness.dispatched, []);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect(
    "rejects unknown origin, forged approval, replay and concurrent requests before dispatch",
    () =>
      Effect.gen(function* () {
        const harness = yield* withService;
        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const input = {
            clientRequestId: "delegate-hold-replay",
            target: targets[0],
            task: "No child.",
            mode: "async" as const,
          } satisfies Parameters<typeof service.delegateTask>[1];
          // Deliberately widen the structurally valid payload with attacker-supplied fields.
          const forgedInput = { ...input, approved: true, isHuman: true, approvalToken: "forged" };
          const errors = yield* Effect.forEach(
            [scope, { ...scope, thread: undefined }, scope, scope],
            (caller) => service.delegateTask(caller, forgedInput).pipe(Effect.flip),
            { concurrency: "unbounded" },
          );
          assert.deepEqual(
            errors.map(({ code }) => code),
            Array(4).fill("capability_denied"),
          );
          assert.deepEqual(harness.dispatched, []);
        }).pipe(Effect.provide(harness.layer));
      }),
  );
});

describe("MCP capability catalog remains truthful while native spawn is held", () => {
  it.effect("advertises no runnable native child even for ready exact Luna", () =>
    Effect.gen(function* () {
      const harness = yield* withService;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const catalog = yield* service.capabilities(scope);
        assert.isAbove(catalog.providers.length, 0);
        for (const provider of catalog.providers) {
          assert.isFalse(provider.canRunChildTask);
          assert.isFalse(provider.canRunCrossProviderChildTask);
          assert.isTrue(
            provider.constraints.some((reason) => reason.includes("authenticated single-use")),
          );
        }
        assert.deepEqual(harness.dispatched, []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
