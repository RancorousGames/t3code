#!/usr/bin/env node
/**
 * Start or resume the one session bound to a TaskBoard live task.
 * A per-task filesystem lock serializes T3 / TaskBoard button clicks across processes.
 * On an indeterminate spawn, never repeat the first prompt or create a second session.
 */
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as Path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  classifySpawnResponse,
  controlAddress,
  createChatGPTSpawnRequest,
  reconcileCreatedSpawn,
  sendAppControlRequest,
} from "./spawn-chatgpt-session.mjs";
import { controlNativeThreads } from "./t3-native-threads.mjs";

const execFile = promisify(execFileCallback);
const ROOT = Path.resolve(import.meta.dirname, "..");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function taskboardExecutable() {
  if (process.env.TASKBOARD_CLI) return process.env.TASKBOARD_CLI;
  const sibling = Path.resolve(ROOT, "../TaskBoard/packages/task-cli/target/release/taskboard.exe");
  return FS.existsSync(sibling) ? sibling : "taskboard.exe";
}

async function taskCommand(
  board,
  args,
  { executable = taskboardExecutable(), run = execFile } = {},
) {
  const { stdout } = await run(executable, [...args, "--root", board], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

function exactRef(input) {
  const board = input.taskRef?.board ?? input.board;
  const id = input.taskRef?.id ?? input.taskId;
  if (
    typeof board !== "string" ||
    !Path.isAbsolute(board) ||
    typeof id !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9]*-[0-9]{4,}$/.test(id)
  )
    throw Error("open-task requires absolute taskRef.board and exact taskRef.id.");
  return { board: Path.resolve(board), id };
}

function taskPrompt(task, { intent = "conversation", board } = {}) {
  const brief = task.live?.brief?.trim();
  const implementation = intent === "implement";
  return [
    implementation
      ? `Implement TaskBoard task ${task.id}: ${task.title}`
      : `Task ${task.id}: ${task.title}`,
    implementation ? `TaskBoard: ${board} (task ${task.id}).` : "",
    task.description ?? "",
    implementation && task.acceptance_criteria?.length
      ? `Acceptance criteria:\n${task.acceptance_criteria.map((criterion) => `- ${criterion}`).join("\n")}`
      : "",
    brief ? `Prepared brief:\n${brief}` : "",
    implementation
      ? [
          "You are an implementation worker, no child agents. Read global/project AGENTS.md instructions and the TaskBoard task; review acceptance criteria and progress.",
          "Implement the task end-to-end now. Preserve other agents' changes; keep checks focused; commit the finished implementation and update the TaskBoard.",
          "Do not simply plan or ask for permission to begin. Do not create a duplicate task.",
        ].join("\n")
      : "Jacob is here now; start by summarizing your understanding and asking your first question.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function openTaskSession(
  input,
  {
    home = Path.join(ROOT, ".t3"),
    exchange = sendAppControlRequest,
    command = taskCommand,
    control,
    native = controlNativeThreads,
  } = {},
) {
  const { board, id } = exactRef(input);
  const lockDir = Path.join(home, "userdata", "task-open-locks");
  const taskKey = Crypto.createHash("sha256")
    .update(board.toLowerCase() + "\0" + id)
    .digest("hex");
  const lock = Path.join(lockDir, taskKey);
  const journal = Path.join(lockDir, `${taskKey}.json`);
  await FSP.mkdir(lockDir, { recursive: true });
  try {
    await FSP.mkdir(lock);
  } catch (error) {
    if (error?.code === "EEXIST")
      return {
        taskRef: { board, id },
        status: "in_progress",
        created: false,
        message: "Another open-task request is in flight. Do not start another session.",
      };
    throw error;
  }
  try {
    let priorAttempt = null;
    try {
      priorAttempt = JSON.parse(await FSP.readFile(journal, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const shown = await command(board, ["task", "show", id]);
    const task = shown.task ?? shown;
    if (task.id !== id) throw Error("TaskBoard returned a different task identity.");
    if (input.requireQueue === true) {
      // T3 may dispatch only a TaskBoard-owned reservation. The TaskBoard
      // board lock is the authority for the request ID and lifecycle state.
      const queueIntent = await command(board, ["task", "execution", id, "show"]);
      const reservationId = input.reservationId;
      const alreadyWorking = queueIntent.queue_state === "working" &&
        queueIntent.queue_reservation_id === reservationId &&
        typeof queueIntent.queue_session_id === "string" &&
        task.claimed_by === `t3:${queueIntent.queue_session_id}`;
      const legacyQitem = typeof queueIntent.queue_request === "string"
        ? `qitem-taskboard-${queueIntent.queue_request}` : null;
      const priorReservationAttempt = priorAttempt?.requestId === reservationId;
      const legacyOpenRig = (queueIntent.queue_attempt || queueIntent.queue_receipt) &&
        queueIntent.queue_retired_receipt !== legacyQitem;
      const identityInvalid = typeof input.queueRequest !== "string" ||
        typeof reservationId !== "string" || !UUID.test(reservationId) ||
        queueIntent.mode !== "queue" ||
        queueIntent.queue_request !== input.queueRequest ||
        queueIntent.queue_reservation_id !== reservationId ||
        !["starting", "working"].includes(queueIntent.queue_state) || legacyOpenRig;
      const taskInvalid = task.archived || task.completed || task.kind !== "task" &&
        task.kind !== "recurring";
      const noLongerReady = !alreadyWorking && (task.claimed_by || task.column !== "ai-ready" ||
        task.attention?.some(flag => ["blocked", "needs-user", "question"].includes(flag)) ||
        task.blocked_reason || task.review_status === "open" || shown.readiness !== "ready");
      if (priorAttempt && !priorReservationAttempt) {
        // A TaskBoard queue item may be dispatched again after its previous T3
        // worker was durably marked Working and later released. The board's
        // new Starting reservation is only possible after that prior lifecycle
        // left Starting; an unresolved spawn is never auto-requeued by TaskBoard.
        // Retire only this task's exact old journal, and only for a fresh,
        // unclaimed Starting reservation with the same immutable queue request.
        const supersededQueueAttempt =
          queueIntent.mode === "queue" &&
          queueIntent.queue_request === input.queueRequest &&
          queueIntent.queue_state === "starting" &&
          queueIntent.queue_reservation_id === reservationId &&
          !task.claimed_by &&
          priorAttempt.intent === "implement" &&
          priorAttempt.kind === "chatgpt" &&
          UUID.test(priorAttempt.requestId ?? "");
        if (supersededQueueAttempt) {
          const saved = JSON.parse(await FSP.readFile(journal, "utf8"));
          if (saved.requestId !== priorAttempt.requestId)
            throw Error("Spawn journal changed during queue lifecycle reconciliation.");
          await FSP.rm(journal);
          priorAttempt = null;
        } else {
          return {
            taskRef: {board, id}, status: "reconcile_required", created: false,
            definitelyNotCreated: false,
            message: "The durable T3 spawn journal belongs to a different request ID; preserve this reservation for manual reconciliation.",
          };
        }
      }
      if (identityInvalid || taskInvalid || (noLongerReady && !priorReservationAttempt)) {
        const definitelyNotCreated = !priorReservationAttempt;
        return {
          taskRef: {board, id},
          status: definitelyNotCreated ? "no_longer_queued" : "reconcile_required",
          created: false, definitelyNotCreated,
          message: priorReservationAttempt
            ? "A prior spawn attempt exists; task eligibility changed, so preserve Starting and reconcile the exact T3 session."
            : "TaskBoard reservation or queue eligibility changed. No session was started.",
        };
      }
    }

    const claim = task.claimed_by;
    const taskRef = { board, id };
    // "t3:" is a stable public ChatGPT session ID in newer Bootstrap flows
    // AND the legacy prefix for native threads. Resolve against actual T3
    // registries; the prefix alone must never decide which UI to open.
    if (typeof claim === "string" && (claim.startsWith("t3-browser:") || claim.startsWith("t3:"))) {
      const browserOnly = claim.startsWith("t3-browser:");
      const claimedId = claim.slice(browserOnly ? "t3-browser:".length : 3);
      const listed = await control(
        { action: "list", which: "all", includeHidden: true },
        { home, exchange },
      );
      const browserMatches = (listed.sessions ?? []).filter((session) =>
        session.id === claimedId || session.publicSessionId === claimedId ||
        session.browserSessionId === claimedId,
      );
      if (browserMatches.length > 1)
        throw Error("Claimed ChatGPT ID matches multiple sessions; refusing ambiguous focus.");
      if (browserMatches.length === 1) {
        const sessionId = browserMatches[0].id;
        if (!input.background) {
          const focused = await control({ action: "focus", sessionId }, { home, exchange });
          if (focused.sessionId !== sessionId)
            throw Error("T3 did not acknowledge the exact claimed session focus.");
        }
        if (task.live?.with_me) await command(board, ["task", "live", "start", id]);
        return { taskRef, status: "opened", kind: "chatgpt", sessionId, created: false };
      }
      if (browserOnly)
        throw Error("Claimed ChatGPT session not present; reconcile saved conversation before replacement.");
      const threadId = claimedId;
      const nativeList = await native(
        { action: "list", expectedEnvironmentId: input.environmentId },
        { home, exchange },
      );
      if (!nativeList.threads?.some((thread) => thread.id === threadId))
        throw Error("Claimed T3 session/thread not found; reconcile saved conversation before replacement.");
      const focused = await native(
        { action: "focus", threadId, expectedEnvironmentId: input.environmentId },
        { home, exchange },
      );
      if (focused.threadId !== threadId) throw Error("Native thread focus was not acknowledged.");
      if (task.live?.with_me) await command(board, ["task", "live", "start", id]);
      return { taskRef, status: "opened", kind: "native", threadId, created: false };
    }
    if (claim) throw Error(`Task is claimed by ${claim}; will not take another agent's claim.`);
    if (input.intent && !["conversation", "implement"].includes(input.intent))
      throw Error("intent must be conversation or implement.");
    const intent = priorAttempt?.intent ?? input.intent ?? "conversation";
    const kind =
      priorAttempt?.kind ??
      input.kind ??
      (await control({ action: "preferences" }, { home, exchange })).liveTaskStartKind ??
      "chatgpt";
    if (!["chatgpt", "claude", "codex"].includes(kind))
      throw Error("kind must be chatgpt, claude or codex.");
    if (kind === "chatgpt") {
      const request = createChatGPTSpawnRequest(
        {
          title: `${task.id} ${task.title}`.slice(0, 80),
          message: taskPrompt(task, { intent, board }),
          parentSessionId: "",
          project: intent === "implement" ? Path.basename(Path.dirname(board)) : "",
          seatId: "",
          role: intent === "implement" ? "worker" : "personal",
          taskBoard: board,
          taskId: id,
        },
        priorAttempt?.requestId ?? (input.requireQueue === true ? input.reservationId : undefined) ?? Crypto.randomUUID(),
      );
      const address = controlAddress(home);
      let response;
      if (!priorAttempt) {
        // Persist the correlation key before any operation that could create a guest.
        await FSP.writeFile(
          journal,
          JSON.stringify({
            kind, intent, requestId: request.requestId,
            taskRef: { board, id },
            queueRequest: input.requireQueue === true ? input.queueRequest : null,
          }),
          { flag: "wx" },
        );
        try {
          response = await exchange(address, request, 90_000);
        } catch {
          /* indeterminate */
        }
      }
      let receipt;
      try {
        receipt = response ? classifySpawnResponse(response, request) : null;
      } catch (error) {
        // A correlated negative T3 response is a definitive rejection before
        // session creation. Only this case may release the TaskBoard start slot.
        if (response?.ok === false) {
          try {
            const saved = JSON.parse(await FSP.readFile(journal, "utf8"));
            if (saved.requestId !== request.requestId)
              throw new Error("Spawn journal belongs to another request.");
            await FSP.rm(journal);
          } catch (cleanupError) {
            // Without removing the exact failed request's journal we cannot
            // accept a fresh reservation ID; keep Starting and reconcile.
            return {
              taskRef, status: "rejected_reconcile_required", created: false,
              definitelyNotCreated: false, requestId: request.requestId,
              message: `T3 rejected before creation, but its journal could not be safely reset: ${String(cleanupError)}`,
            };
          }
          return {
            taskRef, status: "rejected", created: false, definitelyNotCreated: true,
            requestId: request.requestId,
            message: error instanceof Error ? error.message : String(error),
          };
        }
        throw error;
      }
      const result = receipt ?? (await reconcileCreatedSpawn(address, request, exchange));
      if (!result.sessionId)
        return {
          taskRef,
          status: "unknown",
          requestId: request.requestId,
          message:
            "Spawn outcome unknown. Inspect exact request ID before attempting anything else.",
        };
      // Backend-created sessions have permanent IDs at spawn. The canonical
      // public t3: prefix also works with the new Bootstrap session registry.
      if (input.requireQueue === true) {
        await command(board, [
          "task", "queue", "working", id,
          "--queue-request", input.queueRequest,
          "--request-id", input.reservationId,
          "--session-id", result.sessionId,
        ]);
      } else {
        await command(board, ["task", "claim", "--agent", `t3:${result.sessionId}`, id]);
      }
      if (task.live?.with_me) await command(board, ["task", "live", "start", id]);
      if (!input.background)
        await control({ action: "focus", sessionId: result.sessionId }, { home, exchange });
      return {
        taskRef,
        status: result.promptDelivery === "user_turn_observed" ? "created" : "prompt_unknown",
        kind,
        sessionId: result.sessionId,
        requestId: request.requestId,
        created: true,
      };
    }
    const configuration = input.native;
    if (!configuration || configuration.runtime !== kind)
      throw Error(
        "Native tasks need explicit runtime, environment, workspace, provider and model configuration.",
      );
    const clientRequestId = priorAttempt?.requestId ?? Crypto.randomUUID();
    let created;
    if (priorAttempt) {
      const listed = await native(
        { action: "list", expectedEnvironmentId: input.environmentId },
        { home, exchange },
      );
      if (!listed.threads?.some((thread) => thread.id === clientRequestId))
        return {
          taskRef,
          status: "unknown",
          kind,
          requestId: clientRequestId,
          message: "Previous native create outcome not confirmed; never resubmit initial prompt.",
        };
      created = { threadId: clientRequestId };
    } else {
      await FSP.writeFile(journal, JSON.stringify({ kind, intent, requestId: clientRequestId }), {
        flag: "wx",
      });
      created = await native(
        {
          action: "create",
          expectedEnvironmentId: input.environmentId,
          ...configuration,
          title: task.title,
          clientRequestId,
          firstMessage: taskPrompt(task, { intent, board }),
          initialMessageId: Crypto.randomUUID(),
        },
        { home, exchange },
      );
    }
    if (!created.threadId) throw Error("Native creation outcome unknown; no duplicate creation.");
    await command(board, ["task", "claim", "--agent", `t3:${created.threadId}`, id]);
    if (task.live?.with_me) await command(board, ["task", "live", "start", id]);
    await native(
      { action: "focus", threadId: created.threadId, expectedEnvironmentId: input.environmentId },
      { home, exchange },
    );
    return { taskRef, status: "created", kind, threadId: created.threadId, created: true };
  } finally {
    await FSP.rmdir(lock);
  }
}
