import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Bridge from "./ChatGPTDelegation.ts";
import * as Desktop from "./DesktopTransport.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "chatgpt-delegation-" });
  const threadId = ThreadId.make("parent");
  const parent = idleThreadProjection(liveThreadShell(threadId));
  const now = DateTime.makeUnsafe("2026-11-01T12:00:00Z");
  let run: OrchestrationV2Run = {
    id: RunId.make("run-parent"),
    threadId,
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    providerThreadId: null,
    userMessageId: MessageId.make("user-parent"),
    rootNodeId: NodeId.make("root-parent"),
    activeAttemptId: null,
    status: "running",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const scope: McpThreadInvocationScope = {
    environmentId: EnvironmentId.make("environment"),
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: "test",
    client: undefined,
    thread: {
      threadId,
      providerSessionId: "provider-session",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
  };
  let session = {
    conversationId: "00000000-0000-4000-8000-000000000020",
    status: "working",
    completion: null as unknown,
    messages: [{ role: "assistant", text: "" }],
  };
  let created = 0;
  let stopped = 0;
  let loseSpawnReply = false;
  const spawned = yield* Deferred.make<void>();
  const dispatched: OrchestrationV2ServerCommand[] = [];
  const dependencies = Layer.mergeAll(
    Config.layerTest(directory, directory),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed({ ...parent, runs: [run] }),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length, storedEvents: [] };
        }),
    }),
    Layer.mock(Projects.ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: parent.thread.projectId,
          title: "Project",
          workspaceRoot: directory,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-11-01T12:00:00Z",
          updatedAt: "2026-11-01T12:00:00Z",
          deletedAt: null,
        }),
    }),
    Layer.succeed(
      Desktop.DesktopTransport,
      Desktop.DesktopTransport.of({
        available: Effect.succeed(true),
        findSpawn: () => Effect.succeed("session-child"),
        exchange: (request) =>
          request.type === "chatgpt.spawn"
            ? Effect.gen(function* () {
                created++;
                yield* Deferred.succeed(spawned, undefined);
                if (loseSpawnReply)
                  return yield* new Desktop.DesktopTransportError({
                    cause: "lost acknowledgement",
                  });
                return { sessionId: "session-child" };
              })
            : Effect.sync(() => ({ session })),
        stop: () =>
          Effect.sync(() => {
            stopped++;
          }),
      }),
    ),
  );
  const layer = () => Bridge.layer.pipe(Layer.provide(dependencies));
  return {
    scope,
    spawned,
    layer,
    dispatched,
    interruptParent: () => {
      run = { ...run, status: "interrupted" };
    },
    settleParent: () => {
      run = { ...run, status: "completed" };
    },
    resumeParent: () => {
      run = { ...run, status: "running" };
    },
    counts: () => ({ created, stopped }),
    loseSpawnReply: () => {
      loseSpawnReply = true;
    },
    answer: (text: string, complete = false) => {
      session = {
        ...session,
        status: "done_or_idle",
        completion: complete ? {} : null,
        messages: [{ role: "assistant", text }],
      };
    },
    working: () => {
      session = { ...session, status: "working", completion: null };
    },
  };
});
const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.effect(
  "waits for explicit completion, delivers the answer and leaves idle questions unfinished",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.ChatGPTDelegation;
        const child = yield* bridge.delegate(f.scope, {
          task: "Inspect the code",
          clientRequestId: "one",
        });
        f.answer("Which module?");
        yield* bridge.reconcile();
        yield* bridge.reconcile();
        assert.lengthOf(f.dispatched, 0);
        f.settleParent();
        yield* bridge.reconcile();
        const question = yield* bridge.read(f.scope, child.taskId);
        assert.strictEqual(question.status, "waiting");
        assert.strictEqual(question.summary, "Which module?");
        assert.isTrue(question.hasPendingQuestion);
        assert.lengthOf(f.dispatched, 1);
        f.resumeParent();
        f.working();
        yield* bridge.reconcile();
        assert.strictEqual((yield* bridge.read(f.scope, child.taskId)).status, "running");
        f.answer(
          `Inspection finished\n[T3_TASK_DONE:${child.taskId.replace("chatgpt-task:", "")}]`,
        );
        yield* bridge.reconcile();
        assert.lengthOf(f.dispatched, 1);
        f.settleParent();
        yield* bridge.reconcile();
        const finished = yield* bridge.read(f.scope, child.taskId);
        assert.strictEqual(finished.status, "completed");
        assert.strictEqual(finished.summary, "Inspection finished");
        assert.strictEqual(finished.chatgptSessionId, "session-child");
        assert.lengthOf(f.dispatched, 2);
        assert.isTrue(
          f.dispatched.every(
            (command) =>
              command.type === "message.dispatch" &&
              command.threadId === f.scope.thread.threadId &&
              command.notification?.source.kind === "subagent",
          ),
        );
        const other = {
          ...f.scope,
          thread: { ...f.scope.thread, threadId: ThreadId.make("other") },
        };
        const denied = yield* Effect.result(bridge.read(other, child.taskId));
        assert.strictEqual(denied._tag, "Failure");
      }).pipe(Effect.provide(f.layer()));
    }).pipe(Effect.provide(services)),
);

it.effect(
  "reconciles an uncertain spawn by its original request, without creating another session",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.loseSpawnReply();
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.ChatGPTDelegation;
        const input = { task: "Review", clientRequestId: "uncertain" };
        assert.strictEqual((yield* Effect.result(bridge.delegate(f.scope, input)))._tag, "Failure");
        const retry = yield* bridge.delegate(f.scope, input);
        assert.strictEqual(retry.status, "queued");
        f.answer("Recovered original result", true);
        f.settleParent();
        yield* bridge.reconcile();
        const finished = yield* bridge.read(f.scope, retry.taskId);
        assert.strictEqual(finished.summary, "Recovered original result");
        assert.strictEqual(finished.status, "completed");
        assert.strictEqual(f.counts().created, 1);
        assert.lengthOf(f.dispatched, 1);
        assert.strictEqual(
          (yield* Effect.result(bridge.delegate(f.scope, { ...input, task: "Different task" })))
            ._tag,
          "Failure",
        );
      }).pipe(Effect.provide(f.layer()));
    }).pipe(Effect.provide(services)),
);

it.effect(
  "keeps the same task across retries and restarts, and stops work when its parent is interrupted",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const id = yield* Effect.gen(function* () {
        const bridge = yield* Bridge.ChatGPTDelegation;
        const first = yield* bridge.delegate(f.scope, { task: "Review", clientRequestId: "same" });
        const retried = yield* bridge.delegate(f.scope, {
          task: "Review",
          clientRequestId: "same",
        });
        assert.strictEqual(first.taskId, retried.taskId);
        assert.strictEqual(f.counts().created, 1);
        return first.taskId;
      }).pipe(Effect.provide(f.layer()));
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.ChatGPTDelegation;
        f.interruptParent();
        yield* bridge.reconcile();
        assert.strictEqual(f.counts().stopped, 1);
        f.answer("Stopped partial reply");
        yield* bridge.reconcile();
        assert.strictEqual((yield* bridge.cancel(f.scope, id)).status, "cancelled");
        assert.strictEqual(f.counts().stopped, 1);
        assert.strictEqual(f.counts().created, 1);
        assert.lengthOf(f.dispatched, 0);
      }).pipe(Effect.provide(f.layer()));
      f.settleParent();
      yield* Effect.gen(function* () {
        const bridge = yield* Bridge.ChatGPTDelegation;
        yield* bridge.reconcile();
        assert.lengthOf(f.dispatched, 0);
      }).pipe(Effect.provide(f.layer()));
    }).pipe(Effect.provide(services)),
);

it.effect("returns immediately for wait mode and wakes the idle parent on completion", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const bridge = yield* Bridge.ChatGPTDelegation;
      const waiting = yield* bridge
        .delegate(f.scope, { task: "Answer", mode: "wait" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(f.spawned);
      yield* bridge.reconcile();
      assert.strictEqual(waiting.pollUnsafe()?._tag, "Success");
      const result = yield* Fiber.join(waiting);
      assert.isTrue(result.hasPendingChildRuns);
      assert.strictEqual(
        result.next,
        "Completion wakes this thread, so end your turn. Do not wait on it or poll it.",
      );
      f.answer("The answer", true);
      yield* bridge.reconcile();
      assert.lengthOf(f.dispatched, 0);
      f.settleParent();
      yield* bridge.reconcile();
      const finished = yield* bridge.read(f.scope, result.taskId);
      assert.strictEqual(finished.status, "completed");
      assert.strictEqual(finished.summary, "The answer");
      assert.lengthOf(f.dispatched, 1);
      yield* bridge.reconcile();
      assert.lengthOf(f.dispatched, 1);
    }).pipe(Effect.provide(f.layer()));
  }).pipe(Effect.provide(services)),
);
