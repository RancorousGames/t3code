import {
  CommandId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  OrchestratorMcpFailure,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpProviderCapability,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Config from "../config.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { taskPrompt } from "../mcp/delegatedTaskModes.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Desktop from "./DesktopTransport.ts";

const PREFIX = "chatgpt-task:";
export const isChatGPTTask = (taskId: string) => taskId.startsWith(PREFIX);
const Task = Schema.Struct({
  id: NodeId,
  parentThreadId: ThreadId,
  parentRunId: RunId,
  requestKey: Schema.String,
  spawnRequestId: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  project: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["queued", "running", "waiting", "completed", "failed", "cancelled"]),
  summary: Schema.NullOr(Schema.String),
  wake: Schema.Boolean,
  noticeRevision: Schema.Number,
  deliveredRevision: Schema.Number,
  stopRequested: Schema.Boolean,
  spawnAttempted: Schema.Boolean,
});
type Task = typeof Task.Type;
const TaskJson = Schema.fromJsonString(Task);
const encodeTask = Schema.encodeEffect(TaskJson);
const decodeTask = Schema.decodeEffect(TaskJson);
const Session = Schema.Struct({
  session: Schema.Struct({
    id: Schema.optional(Schema.String),
    conversationId: Schema.NullOr(Schema.String),
    status: Schema.String,
    completion: Schema.optional(Schema.NullOr(Schema.Unknown)),
    messages: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
  }),
});
const decodeSession = Schema.decodeUnknownEffect(Session);
const error = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });
const terminal = (task: Task) => ["completed", "failed", "cancelled"].includes(task.status);

export class ChatGPTDelegation extends Context.Service<
  ChatGPTDelegation,
  {
    readonly capability: Effect.Effect<OrchestratorMcpProviderCapability>;
    readonly delegate: (
      scope: McpThreadInvocationScope,
      input: OrchestratorMcpDelegateTaskInput,
    ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
    readonly read: (
      scope: McpThreadInvocationScope,
      taskId: NodeId,
    ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
    readonly cancel: (
      scope: McpThreadInvocationScope,
      taskId: NodeId,
    ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
    readonly reconcile: () => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/chatgpt-delegation/ChatGPTDelegation") {}

const make = Effect.gen(function* () {
  const desktop = yield* Desktop.DesktopTransport;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* Config.ServerConfig;
  const directory = path.join(config.stateDir, "chatgpt-delegation");
  const tasks = new Map<NodeId, Task>();
  const idleReplies = new Map<NodeId, string>();
  const lock = yield* Semaphore.make(1);
  const stateIO = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(() => error("Could not persist ChatGPT delegation state.")));
  const taskPath = (task: Task) => path.join(directory, task.spawnRequestId + ".json");
  const save = Effect.fn("ChatGPTDelegation.save")(function* (task: Task) {
    const file = taskPath(task);
    const encoded = yield* encodeTask(task).pipe(
      Effect.mapError(() => error("Invalid ChatGPT delegation state.")),
    );
    yield* stateIO(fs.writeFileString(file + ".tmp", encoded));
    yield* stateIO(fs.rename(file + ".tmp", file));
    tasks.set(task.id, task);
  });
  yield* fs.makeDirectory(directory, { recursive: true });
  for (const file of yield* fs.readDirectory(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(file)) continue;
    const decoded = yield* decodeTask(yield* fs.readFileString(path.join(directory, file)));
    tasks.set(decoded.id, { ...decoded, wake: decoded.stopRequested ? decoded.wake : true });
  }
  const owned = (scope: McpThreadInvocationScope, id: NodeId) => {
    const task = tasks.get(id);
    return task?.parentThreadId === scope.thread.threadId
      ? Effect.succeed(task)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "task_not_found",
            message: "This ChatGPT task does not belong to the calling thread.",
          }),
        );
  };
  const exchange = Effect.fn("ChatGPTDelegation.exchange")(function* (
    request: Parameters<Desktop.DesktopTransport["Service"]["exchange"]>[0],
  ) {
    return yield* desktop
      .exchange(request)
      .pipe(
        Effect.mapError(() =>
          error(
            "ChatGPT desktop is unavailable or the operation is unconfirmed. The existing request is retained; do not create a replacement.",
          ),
        ),
      );
  });
  const result = (task: Task, waitTimedOut = false): OrchestratorMcpDelegateTaskResult => ({
    taskId: task.id,
    childThreadId: null,
    childRunId: null,
    childNodeId: task.id,
    chatgptSessionId: task.sessionId ?? undefined,
    ...(task.conversationId ? { link: `https://chatgpt.com/c/${task.conversationId}` } : {}),
    status: task.status,
    workState: terminal(task) || task.status === "waiting" ? "result_available" : "working",
    hasPendingChildRuns: !terminal(task),
    latestTerminalRunId: null,
    latestTerminalStatus: terminal(task)
      ? (task.status as "completed" | "failed" | "cancelled")
      : null,
    latestTerminalSummary: terminal(task) ? task.summary : null,
    latestTerminalResultContextTransferId: null,
    providerInstanceId: ProviderInstanceId.make("chatgpt"),
    model: "current",
    summary: task.summary,
    resultContextTransferId: null,
    hasPendingQuestion: task.status === "waiting",
    pendingApproval: null,
    waitTimedOut,
    ...(!terminal(task) && task.status !== "waiting"
      ? { next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT }
      : {}),
  });
  const update = Effect.fn("ChatGPTDelegation.update")(function* (
    task: Task,
    status: Task["status"],
    summary: string | null,
  ) {
    if (task.status === status && task.summary === summary) return task;
    const changed = { ...task, status, summary, noticeRevision: task.noticeRevision + 1 };
    yield* save(changed);
    return changed;
  });
  const spawn = Effect.fn("ChatGPTDelegation.spawn")(function* (task: Task) {
    yield* save({ ...task, spawnAttempted: true });
    const reply = yield* exchange({
      version: 1,
      type: "chatgpt.spawn",
      requestId: task.spawnRequestId,
      title: task.title,
      prompt: task.prompt,
      project: task.project,
      role: "worker",
    });
    if (typeof reply.sessionId !== "string")
      return yield* error(
        "ChatGPT creation has no confirmed session ID. Retry with the same clientRequestId.",
      );
    const created = { ...task, spawnAttempted: true, sessionId: reply.sessionId };
    yield* save(created);
    return created;
  });
  const notify = Effect.fn("ChatGPTDelegation.notify")(function* (task: Task) {
    if (
      !task.wake ||
      task.deliveredRevision >= task.noticeRevision ||
      (!terminal(task) && task.status !== "waiting")
    )
      return;
    const parent = yield* threads
      .getThreadRecords(task.parentThreadId, ["runs"])
      .pipe(
        Effect.mapError(() =>
          error("Could not read the parent before delivering the ChatGPT result."),
        ),
      );
    if (parent.runs.some(Threads.isActiveRun)) return;
    const suffix = `${task.id}:${task.noticeRevision}`;
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`chatgpt-delegation:${suffix}`),
        threadId: task.parentThreadId,
        messageId: MessageId.make(`chatgpt-delegation:${suffix}`),
        text: `ChatGPT delegated task ${task.id} ${task.status === "waiting" ? "needs a reply or has stopped without declaring completion" : task.status}.\n${task.summary ?? ""}\nRead it with task_status. ${task.status === "waiting" ? `Reply through t3_sessions action send, sessionId ${task.sessionId}.` : ""}`,
        notification: {
          source: { kind: "subagent" },
          outcome:
            task.status === "waiting"
              ? "updated"
              : task.status === "failed"
                ? "failed"
                : task.status === "cancelled"
                  ? "cancelled"
                  : "completed",
          summary: `ChatGPT: ${task.title} ${task.status === "waiting" ? "needs a reply" : task.status}`,
        },
        dispatchMode: { type: "queue_after_active" },
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.mapError(() => error("Could not deliver the ChatGPT task result to its parent.")),
      );
    yield* save({ ...task, deliveredRevision: task.noticeRevision });
  });
  const reconcileTask = Effect.fn("ChatGPTDelegation.reconcileTask")(function* (initial: Task) {
    let task = initial;
    if (!terminal(task)) {
      const parent = yield* threads
        .getThreadRecords(task.parentThreadId, ["runs"])
        .pipe(Effect.mapError(() => error("Could not read the ChatGPT task's parent.")));
      const run = parent.runs.find((candidate) => candidate.id === task.parentRunId);
      if (
        parent.thread.deletedAt !== null ||
        !run ||
        ["cancelled", "interrupted", "rolled_back"].includes(run.status)
      ) {
        task = { ...task, stopRequested: true, wake: false };
        yield* save(task);
      }
      if (task.sessionId === null && task.stopRequested && !task.spawnAttempted) {
        task = yield* update(
          task,
          "cancelled",
          "Cancelled before ChatGPT session creation was confirmed.",
        );
        yield* notify(task);
        return;
      }
      if (!(yield* desktop.available)) return;
      if (task.sessionId === null) {
        const found = yield* desktop
          .findSpawn(task.spawnRequestId)
          .pipe(Effect.mapError(() => error("Could not reconcile the original ChatGPT spawn.")));
        if (found === null) return;
        task = { ...task, sessionId: found };
        yield* save(task);
      }
      const raw = yield* exchange({
        version: 1,
        requestId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
        type: "chatgpt.sessions",
        action: "read",
        sessionId: task.sessionId!,
        from: "end",
        count: 2,
        maxMessageChars: 24_000,
        ...(task.conversationId ? { expectedConversationId: task.conversationId } : {}),
      });
      const { session } = yield* decodeSession(raw).pipe(
        Effect.mapError(() => error("The ChatGPT session could not be read.")),
      );
      if (session.conversationId && task.conversationId === null) {
        task = { ...task, conversationId: session.conversationId };
        yield* save(task);
      }
      if (task.stopRequested) {
        if (session.status === "working")
          yield* desktop
            .stop(task.sessionId!, task.conversationId!)
            .pipe(
              Effect.mapError(() =>
                error("ChatGPT stop has not been confirmed; cancellation will be retried."),
              ),
            );
        if (["done_or_idle", "waiting_for_input"].includes(session.status))
          task = yield* update(task, "cancelled", "ChatGPT task cancelled.");
      } else {
        const answer =
          session.messages.findLast((message) => message.role === "assistant")?.text.trim() ?? "";
        const doneMarker = `[T3_TASK_DONE:${task.spawnRequestId}]`;
        if (answer.endsWith(doneMarker)) {
          task = yield* update(task, "completed", answer.slice(0, -doneMarker.length).trim());
          idleReplies.delete(task.id);
        } else if (session.completion && answer) {
          task = yield* update(task, "completed", answer);
          idleReplies.delete(task.id);
        } else if (session.status === "working") {
          idleReplies.delete(task.id);
          task = yield* update(task, "running", null);
        } else if (["done_or_idle", "waiting_for_input"].includes(session.status) && answer) {
          if (idleReplies.get(task.id) === answer) task = yield* update(task, "waiting", answer);
          idleReplies.set(task.id, answer);
        }
      }
    }
    yield* notify(task);
  });
  const reconcile = Effect.fn("ChatGPTDelegation.reconcile")(function* () {
    for (const task of tasks.values()) {
      yield* reconcileTask(task).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("ChatGPT delegation will retry", { taskId: task.id, cause }),
        ),
      );
    }
  }, lock.withPermit);
  return ChatGPTDelegation.of({
    capability: Effect.gen(function* () {
      const available = yield* desktop.available;
      return {
        providerInstanceId: ProviderInstanceId.make("chatgpt"),
        driverKind: "chatgpt",
        displayName: "ChatGPT browser",
        models: [{ id: "current", label: "Current ChatGPT model" }],
        canRunChildTask: available,
        canRunCrossProviderChildTask: available,
        constraints: [
          "Uses the desktop's ChatGPT browser and its current model/settings. Shared workspace only. Use t3_sessions with chatgptSessionId for replies.",
          ...(available ? [] : ["The desktop ChatGPT driver is offline."]),
        ],
      };
    }),
    delegate: Effect.fn("ChatGPTDelegation.delegate")(function* (scope, input) {
      if (
        input.isolation === "worktree" ||
        (input.target?.model !== undefined && input.target.model !== "current") ||
        input.target?.options?.length ||
        (input.runtimeMode !== undefined && input.runtimeMode !== "inherit") ||
        (input.interactionMode !== undefined && input.interactionMode !== "inherit")
      )
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "ChatGPT uses the browser's current model/settings and the shared workspace. Worktree isolation and native runtime/model options are unsupported.",
        });
      const task = yield* lock.withPermit(
        Effect.gen(function* () {
          const key = `${scope.thread.threadId}:${scope.thread.providerSessionId}:${input.clientRequestId ?? (yield* crypto.randomUUIDv4().pipe(Effect.orDie))}`;
          const prior = [...tasks.values()].find((candidate) => candidate.requestKey === key);
          if (prior) {
            if (
              !prior.prompt.startsWith(taskPrompt(input) + "\n\n") ||
              prior.title !== (input.title ?? "ChatGPT delegated task")
            )
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "This clientRequestId already belongs to a different ChatGPT task.",
              });
            return prior;
          }
          if (!(yield* desktop.available))
            return yield* error("Start the T3 desktop app before delegating to ChatGPT.");
          const parent = yield* threads
            .getThreadRecords(scope.thread.threadId, ["runs"])
            .pipe(Effect.mapError(() => error("Could not read the parent run.")));
          const run = parent.runs
            .filter(Threads.isActiveRun)
            .toSorted((a, b) => b.ordinal - a.ordinal)[0];
          if (!run || run.providerInstanceId !== scope.thread.providerInstanceId)
            return yield* new OrchestratorMcpFailure({
              code: "parent_not_active",
              message: "ChatGPT delegation requires an active parent run.",
            });
          const project = yield* projects
            .getById(parent.thread.projectId)
            .pipe(Effect.mapError(() => error("Could not read the parent project.")));
          if (Option.isNone(project)) return yield* error("The parent project is missing.");
          const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          const fresh: Task = {
            id: NodeId.make(PREFIX + id),
            parentThreadId: scope.thread.threadId,
            parentRunId: run.id,
            requestKey: key,
            spawnRequestId: id,
            title: input.title ?? "ChatGPT delegated task",
            project: project.value.title,
            prompt: `${taskPrompt(input)}\n\nYou are a ChatGPT subagent of a native T3 thread. Work in ${parent.thread.worktreePath ?? project.value.workspaceRoot}. Do the assigned work yourself. When finished, give your final result and put [T3_TASK_DONE:${id}] on its own final line. This exact marker declares completion to the parent; no separate complete tool call is needed. If you need a decision, ask it in your reply without the completion marker; the parent will receive it and answer in this session.`,
            sessionId: null,
            conversationId: null,
            status: "queued",
            summary: null,
            wake: true,
            noticeRevision: 0,
            deliveredRevision: 0,
            stopRequested: false,
            spawnAttempted: false,
          };
          yield* save(fresh);
          return yield* spawn(fresh);
        }),
      );
      // An open MCP call lets the parent keep generating; completion must resume a settled turn.
      return result(task);
    }),
    read: Effect.fn("ChatGPTDelegation.read")(function* (scope, id) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const task = yield* owned(scope, id);
          yield* save({ ...task, deliveredRevision: task.noticeRevision });
          return result(task);
        }),
      );
    }),
    cancel: Effect.fn("ChatGPTDelegation.cancel")(function* (scope, id) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const task = yield* owned(scope, id);
          if (terminal(task))
            return { taskId: id, status: task.status as "completed" | "failed" | "cancelled" };
          yield* save({ ...task, stopRequested: true });
          return { taskId: id, status: "cancel_requested" as const };
        }),
      );
    }),
    reconcile,
    start: Effect.fn("ChatGPTDelegation.start")(() =>
      forkParked(reconcile().pipe(Effect.repeat({ schedule: Schedule.spaced("2 seconds") }))),
    ),
  });
});

export const layer = Layer.effect(ChatGPTDelegation, make);
