import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Orchestrator from "./Orchestrator.ts";
import { assessNativeSpawnCatalogTarget } from "./NativeSpawnPolicy.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as Legacy from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Projects from "../project/ProjectService.ts";
import * as SetupTracker from "../project/WorktreeSetupTracker.ts";
import * as CloneTracker from "../project/ProjectCloneTracker.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Git from "../git/GitWorkflowService.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as Registry from "../provider/ProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const commandId = CommandId.make("command:spawn-hold");
const threadId = ThreadId.make("thread:spawn-hold");
const projectId = ProjectId.make("project:spawn-hold");
const models = ["gpt-6-astra", "gpt-5.6-luna", "claude-opus-5-5", "unknown", "gpt-6-luna"];

describe("root creation restored while delegated and forked native creation stay held", () => {
  it.effect.each(models)(
    "dispatches ordinary root for %s while denying delegation and fork before effects",
    (model) =>
      Effect.gen(function* () {
        const effects: string[] = [];
        const layer = ThreadManagement.layerWithLegacyImporter.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({
                dispatch: () =>
                  Effect.sync(() => {
                    effects.push("dispatch");
                    return { sequence: 1, storedEvents: [] };
                  }),
              }),
              Layer.mock(Legacy.LegacyV1ThreadImporter)({
                ensureTranscript: () =>
                  Effect.sync(() => {
                    effects.push("transcript");
                    return { importedThreadCount: 0, importedMessageCount: 0 };
                  }),
              }),
              Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
              Layer.mock(Receipts.CommandReceiptStoreV2)({}),
              ServerSettings.layerTest(),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadManagement.ThreadManagementService;
          const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model };
          const create = {
            type: "thread.create",
            commandId,
            threadId,
            projectId,
            title: "Ordinary root",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          } as const;
          const delegate = {
            type: "delegated_task.request",
            commandId,
            parentThreadId: threadId,
            parentRunId: RunId.make("run:parent"),
            parentNodeId: NodeId.make("node:parent"),
            task: "Must not start",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            completionWake: "always",
            createdBy: "user",
            creationSource: "web",
          } as const;
          yield* service.dispatch(create);
          assert.deepEqual(effects, ["dispatch"], "ordinary roots reach the orchestrator");
          const fork = {
            type: "thread.fork",
            commandId,
            sourceThreadId: threadId,
            targetThreadId: ThreadId.make("thread:spawn-hold-fork"),
            sourcePoint: { type: "run", runId: RunId.make("run:parent") },
            createdBy: "user",
            creationSource: "web",
          } as const;
          for (const command of [delegate, fork]) {
            const error = yield* service.dispatch(command).pipe(Effect.flip);
            assert.equal(error._tag, "OrchestratorCommandRejectedError");
            assert.isTrue(
              typeof error.cause === "object" &&
                error.cause !== null &&
                "_tag" in error.cause &&
                error.cause._tag === "NativeSpawnApprovalUnavailable",
            );
          }
          assert.deepEqual(effects, ["dispatch"], "delegation and fork still have zero effects");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("ordinary launch reaches normal project validation before provisioning", () =>
    Effect.gen(function* () {
      const touched: string[] = [];
      const layer = ThreadLaunch.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Projects.ProjectService)({
              getById: () =>
                Effect.sync(() => {
                  touched.push("project");
                  return Option.none();
                }),
            }),
            Layer.mock(SetupTracker.WorktreeSetupTracker)({}),
            Layer.mock(CloneTracker.ProjectCloneTracker)({
              get: () =>
                Effect.sync(() => {
                  touched.push("clone");
                  return null;
                }),
            }),
            Layer.mock(Terminals.TerminalManager)({}),
            Layer.mock(Git.GitWorkflowService)({}),
            Layer.mock(Setup.ProjectSetupScriptRunner)({}),
            Layer.mock(Registry.ProviderRegistry)({}),
            ServerSettings.layerTest(),
            Layer.mock(TextGeneration.TextGeneration)({}),
            Layer.mock(Receipts.CommandReceiptStoreV2)({}),
            IdAllocator.layer,
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(ManagedFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadLaunch.ThreadLaunchService;
        for (const reuseExistingThread of [false, true]) {
          const error = yield* service
            .launch({
              commandId,
              threadId,
              projectId,
              title: "Held",
              reuseExistingThread,
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-6-astra",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: { text: "Must not provision", attachments: [] },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.flip);
          assert.equal(error._tag, "ThreadLaunchError");
        }
        assert.equal(touched.filter((effect) => effect === "project").length, 2);
        assert.isTrue(touched.every((effect) => effect === "clone" || effect === "project"));
      }).pipe(Effect.provide(layer));
    }),
  );
});

describe("server catalog assessment never grants spawn authority", () => {
  const codex = ProviderInstanceId.make("codex");
  const available = {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: "test",
    checkedAt: "2026-10-20T00:00:00.000Z",
    models: [
      { slug: "gpt-6-luna", name: "Luna", isCustom: false, capabilities: null },
      { slug: "gpt-5.6-luna", name: "5.6 Luna", isCustom: false, capabilities: null },
      { slug: "gpt-6-astra", name: "Astra", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  } as ServerProvider;
  const assess = (
    model: string,
    provider: ServerProvider | undefined = available,
    options: Parameters<
      typeof assessNativeSpawnCatalogTarget
    >[0]["selection"]["options"] = undefined,
  ) =>
    assessNativeSpawnCatalogTarget({
      executionEnvironmentId: "environment:real",
      catalogEnvironmentId: "environment:real",
      selection: { instanceId: codex, model, ...(options ? { options } : {}) },
      provider,
      orchestrationAdapterRegistered: true,
      enabledForProject: true,
    });

  it("recognizes only exact ready codex:gpt-6-luna as a candidate, not approval", () => {
    assert.equal(assess("gpt-6-luna"), "exact-luna-candidate");
    assert.equal(assess("gpt-5.6-luna"), "human-approval-required");
    assert.equal(assess("gpt-6-astra"), "human-approval-required");
    assert.equal(assess("claude-opus-5-5"), "unverified-target");
    assert.equal(assess("gpt-6-luna-spoof"), "unverified-target");
    assert.equal(assess("unknown"), "unverified-target");
    assert.equal(
      assess("gpt-6-luna", { ...available, driver: ProviderDriverKind.make("claudeAgent") }),
      "human-approval-required",
    );
  });

  it("fails classification closed on nonmatching/unavailable server catalog evidence", () => {
    const base = {
      executionEnvironmentId: "environment:real",
      catalogEnvironmentId: "environment:real",
      selection: { instanceId: codex, model: "gpt-6-luna" },
      provider: available,
      orchestrationAdapterRegistered: true,
      enabledForProject: true,
    } as const;
    for (const override of [
      { catalogEnvironmentId: "environment:forged" },
      { selection: { instanceId: ProviderInstanceId.make("unknown"), model: "gpt-6-luna" } },
      { provider: undefined },
      { provider: { ...available, enabled: false } },
      { provider: { ...available, installed: false } },
      { provider: { ...available, status: "error" as const } },
      { provider: { ...available, auth: { status: "unauthenticated" as const } } },
      { provider: { ...available, availability: "unavailable" as const } },
      { orchestrationAdapterRegistered: false },
      { enabledForProject: false },
    ]) {
      assert.equal(assessNativeSpawnCatalogTarget({ ...base, ...override }), "unverified-target");
    }
  });

  it("does not infer effective model options from absent provider descriptors", () => {
    assert.equal(
      assess("gpt-6-luna", available, [{ id: "reasoning", value: "low" }]),
      "unverified-target",
    );
    assert.equal(
      assess(
        "gpt-6-luna",
        {
          ...available,
          models: [
            {
              slug: "gpt-6-luna",
              name: "Luna",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoning",
                    label: "Reasoning",
                    type: "select",
                    options: [
                      { id: "low", label: "Low" },
                      { id: "high", label: "High" },
                    ],
                  },
                ],
              },
            },
          ],
        } as ServerProvider,
        [
          { id: "reasoning", value: "low" },
          { id: "reasoning", value: "high" },
        ],
      ),
      "unverified-target",
    );
  });
});
