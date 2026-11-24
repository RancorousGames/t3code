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
import { DatabaseSync } from "node:sqlite";
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

/** Resolve saved TaskBoard model preference into a native T3 runtime. */
export function taskRuntimeFromSelection(selection) {
  if (!selection) return "chatgpt";
  const provider = selection.provider;
  if (provider === "chatgpt") return "chatgpt";
  if (provider === "claudeAgent" || provider.startsWith("claudeAgent_")) return "claude";
  if (provider === "codex" || provider.startsWith("codex_")) return "codex";
  if (provider === "opencode" || provider.startsWith("opencode_")) return "opencode";
  throw Error(`Unsupported TaskBoard provider: ${String(provider)}`);
}

export function claudeQuotaAvailable(provider, model, now = Date.now()) {
  return !provider.usageWindows?.some(
    ({ id, usedPercent, resetsAt }) =>
      usedPercent >= 100 &&
      (!resetsAt || Date.parse(resetsAt) > now) &&
      (id === "five_hour" ||
        id === "seven_day" ||
        (id.startsWith("seven_day_") && model.includes(id.slice("seven_day_".length)))),
  );
}

function taskboardExecutable() {
  if (process.env.TASKBOARD_CLI) return process.env.TASKBOARD_CLI;
  const sibling = Path.resolve(ROOT, "../TaskBoard/TaskBoard.exe");
  return FS.existsSync(sibling) ? sibling : "taskboard.exe";
}

async function taskCommand(
  board,
  args,
  { executable = taskboardExecutable(), run = execFile } = {},
) {
  const { stdout } = await run(executable, ["--json", "--root", board, ...args], {
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

/** Only reopen a conversation if the durable transcript index identifies a single owner. */
function knownConversationForSession(home, sessionId) {
  const database = Path.join(home, "userdata", "statev2.sqlite");
  if (!FS.existsSync(database)) return null;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT DISTINCT conversation_id FROM chatgpt_messages WHERE session_id = ? LIMIT 2")
      .all(sessionId);
    return rows.length === 1 && UUID.test(rows[0].conversation_id) ? rows[0].conversation_id : null;
  } catch (error) {
    if (/no such table/.test(String(error))) return null;
    throw error;
  } finally {
    db.close();
  }
}
/** The server projection gives native projects without any existing threads a workspace. */
function knownNativeProjects(home, boardName) {
  const database = Path.join(home, "userdata", "statev2.sqlite");
  if (!FS.existsSync(database)) return [];
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT project_id AS projectId, title, workspace_root AS workspaceRoot, " +
          "default_model_selection_json AS defaultModel FROM projection_projects WHERE deleted_at IS NULL",
      )
      .all()
      .filter((project) => project.title.replace(/[^a-z0-9]/gi, "").toLowerCase() === boardName);
  } catch (error) {
    if (/no such table|no such column/.test(String(error))) return [];
    throw error;
  } finally {
    db.close();
  }
}
/** Resolve a native default only when the board maps to one existing T3 project. */
async function nativeLaunchForBoard(
  board,
  kind,
  environmentId,
  native,
  home,
  exchange,
  explicitModel = null,
  checkQuota = false,
) {
  const desiredDriver = kind === "claude" ? "claudeAgent" : kind;
  const projects = await native(
    { action: "list", expectedEnvironmentId: environmentId },
    { home, exchange },
  );
  const boardName = Path.basename(Path.dirname(board))
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  const matches = (projects.threads ?? []).filter(
    (thread) =>
      thread.workspaceRoot &&
      thread.projectId &&
      thread.project?.replace(/[^a-z0-9]/gi, "").toLowerCase() === boardName,
  );
  const indexedProjects = knownNativeProjects(home, boardName);
  const roots = [
    ...new Map([
      ...matches.map((thread) => [
        thread.projectId,
        { projectId: thread.projectId, workspaceRoot: thread.workspaceRoot },
      ]),
      ...indexedProjects.map((project) => [
        project.projectId,
        {
          projectId: project.projectId,
          workspaceRoot: project.workspaceRoot,
          defaultModel: project.defaultModel,
        },
      ]),
    ]).values(),
  ];
  if (roots.length > 1)
    throw Error("Native task maps to multiple T3 projects; select one workspace explicitly.");
  // TaskBoards that have no corresponding T3 project still need a native workspace.
  // The board parent is stable and exact; native T3 creates its own project there.
  if (!roots.length) roots.push({ workspaceRoot: Path.dirname(board) });
  const providers = await native(
    { action: "providers", expectedEnvironmentId: projects.environmentId },
    { home, exchange },
  );
  const ready = (providers.providers ?? []).filter(
    (provider) =>
      provider.driver === desiredDriver &&
      provider.enabled &&
      provider.installed &&
      provider.status === "ready" &&
      provider.available !== false,
  );
  const previous = matches.find((thread) =>
    ready.some((provider) => provider.providerInstanceId === thread.providerInstanceId),
  );
  let defaultSelection = null;
  try {
    defaultSelection = roots[0].defaultModel ? JSON.parse(roots[0].defaultModel) : null;
  } catch {
    /* invalid saved preference must never guess an incompatible provider */
  }
  const supporting = explicitModel
    ? ready.filter(
        (provider) =>
          provider.models.some((model) => model.slug === explicitModel.model) &&
          (provider.providerInstanceId === explicitModel.provider ||
            provider.driver === explicitModel.provider),
      )
    : [];
  const selected = explicitModel
    ? (supporting.find((provider) => provider.providerInstanceId === explicitModel.provider) ??
      supporting.find(
        (provider) =>
          provider.providerInstanceId ===
          (defaultSelection?.instanceId ?? defaultSelection?.provider),
      ) ??
      (supporting.length === 1 ? supporting[0] : null))
    : previous
      ? ready.find((provider) => provider.providerInstanceId === previous.providerInstanceId)
      : (ready.find(
          (provider) =>
            provider.providerInstanceId ===
            (defaultSelection?.instanceId ?? defaultSelection?.provider),
        ) ?? (ready.length === 1 ? ready[0] : null));
  if (!selected)
    throw Error("No unique ready native provider for this task; choose a provider explicitly.");
  if (checkQuota && kind === "claude" && !claudeQuotaAvailable(selected, explicitModel.model))
    return null;
  const model = explicitModel
    ? selected.models.find((entry) => entry.slug === explicitModel.model)?.slug
    : (selected.models.find((entry) => entry.slug === previous?.modelSelection?.model)?.slug ??
      selected.models.find((entry) => entry.slug === defaultSelection?.model)?.slug ??
      selected.models.find((entry) => entry.isDefault)?.slug ??
      (selected.models.length === 1 ? selected.models[0].slug : null));
  if (!model) throw Error("No unambiguous native default model for this task.");
  return {
    runtime: kind,
    ...(roots[0].projectId ? { projectId: roots[0].projectId } : {}),
    workspaceRoot: roots[0].workspaceRoot,
    providerInstanceId: selected.providerInstanceId,
    modelSelection: {
      instanceId: selected.providerInstanceId,
      model,
      ...(explicitModel
        ? { options: [{ id: "reasoningEffort", value: explicitModel.effort ?? "medium" }] }
        : {}),
    },
    // A model saved on the task already carries recorded user approval (TaskBoard --user-approval),
    // so those workers run unattended in full access; ad hoc native opens stay supervised.
    runtimeMode: explicitModel ? "full-access" : "approval-required",
    environmentId: projects.environmentId,
  };
}
function taskPrompt(task, { intent = "conversation", board, queue } = {}) {
  const brief = task.live?.brief?.trim();
  const implementation = intent === "implement";
  return [
    implementation
      ? `Implement TaskBoard task ${task.id}: ${task.title}`
      : `Task ${task.id}: ${task.title}`,
    implementation ? `TaskBoard: ${board} (task ${task.id}).` : "",
    queue?.requireQueue
      ? `If TaskBoard still shows Starting, claim your reservation with TaskBoard.exe --root "${board}" --json task queue working ${task.id} --queue-request ${queue.queueRequest} --request-id ${queue.reservationId} --session-id <your T3 session UUID>.`
      : "",
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
    conversationLookup = knownConversationForSession,
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
    let previousNative = null;
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
      const alreadyWorking =
        queueIntent.queue_state === "working" &&
        queueIntent.queue_reservation_id === reservationId &&
        typeof queueIntent.queue_session_id === "string" &&
        task.claimed_by === `t3:${queueIntent.queue_session_id}`;
      const legacyQitem =
        typeof queueIntent.queue_request === "string"
          ? `qitem-taskboard-${queueIntent.queue_request}`
          : null;
      const priorReservationAttempt = priorAttempt?.requestId === reservationId;
      const legacyOpenRig =
        (queueIntent.queue_attempt || queueIntent.queue_receipt) &&
        queueIntent.queue_retired_receipt !== legacyQitem;
      const identityInvalid =
        typeof input.queueRequest !== "string" ||
        typeof reservationId !== "string" ||
        !UUID.test(reservationId) ||
        queueIntent.mode !== "queue" ||
        queueIntent.queue_request !== input.queueRequest ||
        queueIntent.queue_reservation_id !== reservationId ||
        !["starting", "working"].includes(queueIntent.queue_state) ||
        legacyOpenRig;
      const taskInvalid =
        task.archived || task.completed || (task.kind !== "task" && task.kind !== "recurring");
      // TaskBoard owns green-column eligibility. A column ID of "ai-ready"
      // is not required: other columns can be green and dispatchable. The
      // reservation and final atomic claim recheck authoritative readiness.
      const noLongerReady =
        !alreadyWorking &&
        (task.claimed_by ||
          task.attention?.some((flag) => ["blocked", "needs-user", "question"].includes(flag)) ||
          task.blocked_reason ||
          task.review_status === "open" ||
          shown.readiness !== "ready");
      // Every launch writes its journal under this task lock before calling T3.
      // Recovery can therefore release an interrupted pre-launch transition.
      if (input.reconcileOnly && !priorReservationAttempt) {
        return {
          taskRef: { board, id },
          status: "not_started",
          definitelyNotCreated: true,
          message: "No launch was attempted for this reservation.",
        };
      }
      // The journal predates spawn. After quarantine, recover an orphan only
      // under this task lock and TaskBoard's exact reservation comparison.
      if (
        input.reconcileOnly &&
        priorReservationAttempt &&
        priorAttempt.kind === "chatgpt" &&
        !identityInvalid &&
        !taskInvalid &&
        !task.claimed_by &&
        queueIntent.queue_state === "starting" &&
        Date.now() - Date.parse(queueIntent.queue_state_since) >= 30 * 60_000
      ) {
        const response = await exchange(
          controlAddress(home),
          {
            version: 1,
            requestId: Crypto.randomUUID(),
            type: "chatgpt.sessions",
            action: "list",
            which: "all",
            includeHidden: true,
          },
          20_000,
        );
        const inventory = response?.data;
        if (
          response?.ok &&
          Array.isArray(inventory?.sessions) &&
          inventory.total === inventory.sessions.length &&
          !inventory.hasMore &&
          !inventory.incomplete &&
          !inventory.sessions.some((session) => {
            const ref = session.binding?.taskRef;
            return (
              session.spawnRequestId === reservationId ||
              (ref?.id === id &&
                Path.resolve(ref.board).toLowerCase() === board.toLowerCase() &&
                session.activity !== "idle")
            );
          })
        ) {
          await command(board, [
            "task",
            "queue",
            "abandon",
            id,
            "--queue-request",
            input.queueRequest,
            "--request-id",
            reservationId,
            "--verified-no-live-session",
            "--reason",
            "No exact worker in complete T3 inventory after 30-minute startup quarantine.",
          ]);
          return { taskRef: { board, id }, status: "requeued", created: false };
        }
      }
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
          ["chatgpt", "claude", "codex", "opencode"].includes(priorAttempt.kind) &&
          UUID.test(priorAttempt.requestId ?? "");
        if (supersededQueueAttempt) {
          const saved = JSON.parse(await FSP.readFile(journal, "utf8"));
          if (saved.requestId !== priorAttempt.requestId)
            throw Error("Spawn journal changed during queue lifecycle reconciliation.");
          if (priorAttempt.kind !== "chatgpt") previousNative = priorAttempt;
          else await FSP.rm(journal);
          priorAttempt = null;
        } else {
          return {
            taskRef: { board, id },
            status: "reconcile_required",
            created: false,
            definitelyNotCreated: false,
            message:
              "The durable T3 spawn journal belongs to a different request ID; preserve this reservation for manual reconciliation.",
          };
        }
      }
      if (identityInvalid || taskInvalid || (noLongerReady && !priorReservationAttempt)) {
        const definitelyNotCreated = !priorReservationAttempt;
        return {
          taskRef: { board, id },
          status: definitelyNotCreated ? "no_longer_queued" : "reconcile_required",
          created: false,
          definitelyNotCreated,
          message: priorReservationAttempt
            ? "A prior spawn attempt exists; task eligibility changed, so preserve Starting and reconcile the exact T3 session."
            : "TaskBoard reservation or queue eligibility changed. No session was started.",
        };
      }
    }

    // Manual Start-now tasks can retain an UNKNOWN spawn journal even after
    // their blank browser was later closed. Re-arm only after a read-only T3
    // registry lookup proves the *exact* old reservation was closed without
    // creating a conversation or receiving a user turn. Missing registry
    // records are not closure evidence.
    if (
      priorAttempt?.kind === "chatgpt" &&
      input.requireQueue !== true &&
      !task.claimed_by &&
      typeof control === "function"
    ) {
      const listed = await control(
        { action: "list", which: "all", includeHidden: true },
        { home, exchange },
      );
      if (
        Array.isArray(listed.sessions) &&
        !listed.hasMore &&
        !listed.incomplete &&
        (listed.total === undefined || listed.total === listed.sessions.length)
      ) {
        const matches = listed.sessions.filter(
          (session) => session.spawnRequestId === priorAttempt.requestId,
        );
        const old = matches.length === 1 ? matches[0] : null;
        if (
          old?.closedAt != null &&
          !old.conversationId &&
          old.bootstrapIdentity?.state === "awaiting_marker" &&
          !old.bootstrapIdentity.conversationId &&
          old.binding?.taskRef?.id === id &&
          old.binding?.taskRef?.board &&
          Path.normalize(old.binding.taskRef.board).toLowerCase() === board.toLowerCase() &&
          !old.lastRole &&
          (old.totalTurns == null || old.totalTurns === 0)
        ) {
          const saved = JSON.parse(await FSP.readFile(journal, "utf8"));
          if (saved.requestId !== priorAttempt.requestId)
            throw Error("Task spawn journal changed during closed-guest reconciliation.");
          await FSP.rename(journal, `${journal}.retired-${priorAttempt.requestId}`);
          priorAttempt = null;
        }
      }
    }
    const claim = task.claimed_by;
    const taskRef = { board, id };
    const reopenKnownConversation = async (oldSessionId) => {
      const conversationId = await conversationLookup(home, oldSessionId);
      if (!conversationId) return null;
      // T3's open action deduplicates the canonical conversation URL even when
      // the original session is hidden, archived, or no longer mounted.
      const opened = await control(
        { action: "open", sessionId: conversationId },
        { home, exchange },
      );
      if (opened.conversationId !== conversationId || !opened.sessionId)
        throw Error("T3 did not acknowledge the exact recovered conversation.");
      // TaskBoard recovery never changes the user's selected session.
      // The historical claim remains until TaskBoard can atomically transfer it:
      // releasing it here would allow another dispatcher to steal the task.
      if (task.live?.with_me) await command(board, ["task", "live", "start", id]);
      return {
        taskRef,
        status: "opened",
        kind: "chatgpt",
        sessionId: opened.sessionId,
        conversationId,
        created: false,
        claimRebindRequired: opened.sessionId !== oldSessionId,
      };
    };
    // "t3:" is a stable public ChatGPT session ID in newer Bootstrap flows
    // AND the legacy prefix for native threads. Resolve against actual T3
    // registries; the prefix alone must never decide which UI to open.
    if (
      typeof claim === "string" &&
      (claim.startsWith("t3-browser:") || claim.startsWith("t3:") || UUID.test(claim))
    ) {
      const browserOnly = claim.startsWith("t3-browser:") || UUID.test(claim);
      const claimedId = UUID.test(claim)
        ? claim
        : claim.slice(browserOnly ? "t3-browser:".length : 3);
      const listed = await control(
        { action: "list", which: "all", includeHidden: true },
        { home, exchange },
      );
      const browserMatches = (listed.sessions ?? []).filter(
        (session) =>
          session.id === claimedId ||
          session.publicSessionId === claimedId ||
          session.browserSessionId === claimedId,
      );
      if (browserMatches.length > 1)
        throw Error("Claimed ChatGPT ID matches multiple sessions; refusing ambiguous focus.");
      if (browserMatches.length === 1) {
        const sessionId = browserMatches[0].id;
        // Repair only a provably unsent TaskBoard first prompt, with the exact
        // original durable spawn request. T3 itself checks the persisted
        // not_sent/sendAttempted=false receipt before starting delivery.
        if (
          input.requireQueue === true &&
          !input.reconcileOnly &&
          input.reservationId === priorAttempt?.requestId &&
          browserMatches[0].spawnRequestId === input.reservationId &&
          browserMatches[0].promptDelivery === "not_sent" &&
          browserMatches[0].sendAttempted === false
        ) {
          const request = createChatGPTSpawnRequest(
            {
              title: `${task.id} ${task.title}`.slice(0, 80),
              message: taskPrompt(task, { intent: "implement", board }),
              parentSessionId: "",
              project: Path.basename(Path.dirname(board)),
              seatId: "",
              role: "worker",
              autoClose: true,
              taskBoard: board,
              taskId: id,
            },
            input.reservationId,
          );
          await exchange(controlAddress(home), request, 25_000);
        }
        if (task.live?.with_me) await command(board, ["task", "live", "start", id]);
        return { taskRef, status: "opened", kind: "chatgpt", sessionId, created: false };
      }
      if (browserOnly) {
        const recovered = await reopenKnownConversation(claimedId);
        if (recovered) return recovered;
        throw Error(
          "Claimed ChatGPT session not present and no unique saved conversation is known; never create a duplicate.",
        );
      }
      const threadId = claimedId;
      const nativeList = await native(
        { action: "list", expectedEnvironmentId: input.environmentId },
        { home, exchange },
      );
      if (!nativeList.threads?.some((thread) => thread.id === threadId)) {
        const recovered = await reopenKnownConversation(claimedId);
        if (recovered) return recovered;
        throw Error(
          "Claimed T3 thread missing and no unique saved ChatGPT conversation is known; never create a duplicate.",
        );
      }
      if (task.live?.with_me) await command(board, ["task", "live", "start", id]);
      return { taskRef, status: "opened", kind: "native", threadId, created: false };
    }
    if (claim) throw Error(`Task is claimed by ${claim}; will not take another agent's claim.`);
    if (input.intent && !["conversation", "implement"].includes(input.intent))
      throw Error("intent must be conversation or implement.");
    const intent = priorAttempt?.intent ?? input.intent ?? "conversation";
    // A saved task choice takes precedence over the old Start-now preference.
    // Missing model_selection is always ChatGPT, including legacy tasks.
    const selectedModel = task.model_selection ?? null;
    const kind = priorAttempt?.kind ?? taskRuntimeFromSelection(selectedModel);
    if (!["chatgpt", "claude", "codex", "opencode"].includes(kind))
      throw Error("Task model provider is unsupported by T3.");
    if (kind === "chatgpt") {
      const request = createChatGPTSpawnRequest(
        {
          title: `${task.id} ${task.title}`.slice(0, 80),
          message: taskPrompt(task, { intent, board, queue: input }),
          parentSessionId: "",
          project: intent === "implement" ? Path.basename(Path.dirname(board)) : "",
          seatId: "",
          role: intent === "implement" ? "worker" : "personal",
          autoClose: intent === "implement",
          taskBoard: board,
          taskId: id,
        },
        priorAttempt?.requestId ??
          (input.requireQueue === true ? input.reservationId : undefined) ??
          Crypto.randomUUID(),
      );
      if (previousNative) await FSP.rm(journal);
      const address = controlAddress(home);
      let response;
      if (!priorAttempt) {
        // Persist the correlation key before any operation that could create a guest.
        await FSP.writeFile(
          journal,
          JSON.stringify({
            kind,
            intent,
            requestId: request.requestId,
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
              taskRef,
              status: "rejected_reconcile_required",
              created: false,
              definitelyNotCreated: false,
              requestId: request.requestId,
              message: `T3 rejected before creation, but its journal could not be safely reset: ${String(cleanupError)}`,
            };
          }
          return {
            taskRef,
            status: "rejected",
            created: false,
            definitelyNotCreated: true,
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
      // A created browser slot is not an agent. Preserve the existing Starting
      // reservation (or the durable manual journal) until ChatGPT has actually
      // shown the initial user turn. UNKNOWN deliveries must not acquire a
      // TaskBoard claim: blank guests are retired separately without replay.
      if (result.promptDelivery === "user_turn_observed") {
        if (input.requireQueue === true) {
          await command(board, [
            "task",
            "queue",
            "working",
            id,
            "--queue-request",
            input.queueRequest,
            "--request-id",
            input.reservationId,
            "--session-id",
            result.sessionId,
          ]);
        } else {
          await command(board, ["task", "claim", "--agent", `t3:${result.sessionId}`, id]);
        }
        if (task.live?.with_me) await command(board, ["task", "live", "start", id]);
      }
      return {
        taskRef,
        status: result.promptDelivery === "user_turn_observed" ? "created" : "prompt_unknown",
        kind,
        sessionId: result.sessionId,
        requestId: request.requestId,
        created: true,
      };
    }
    const configuration =
      (selectedModel ? null : input.native) ??
      (await nativeLaunchForBoard(
        board,
        kind,
        input.environmentId,
        native,
        home,
        exchange,
        selectedModel,
        input.requireQueue && !priorAttempt,
      ));
    if (!configuration)
      return {
        taskRef,
        status: "usage_limited",
        definitelyNotCreated: true,
        message: "Claude usage limit reached.",
      };
    if (configuration.runtime !== kind)
      throw Error("Native task runtime does not match its selected kind.");
    const nativeEnvironmentId = input.environmentId ?? configuration.environmentId;
    const clientRequestId =
      priorAttempt?.requestId ?? (input.requireQueue ? input.reservationId : Crypto.randomUUID());
    const message = taskPrompt(task, { intent, board, queue: input });
    let created;
    if (previousNative && previousNative.kind === kind) {
      const threadId = previousNative.threadId ?? previousNative.requestId;
      const listed = await native(
        { action: "list", expectedEnvironmentId: nativeEnvironmentId },
        { home, exchange },
      );
      const previous = listed.threads?.find((thread) => thread.id === threadId);
      if (
        previous &&
        previous.providerInstanceId === configuration.providerInstanceId &&
        previous.modelSelection?.model === configuration.modelSelection.model
      ) {
        await FSP.writeFile(
          journal,
          JSON.stringify({ kind, intent, requestId: clientRequestId, threadId }),
        );
        await native(
          {
            action: "send",
            threadId,
            clientRequestId,
            message,
            expectedEnvironmentId: nativeEnvironmentId,
          },
          { home, exchange },
        );
        created = { threadId };
      }
    }
    if (!created && priorAttempt?.threadId) {
      const receipt = await native(
        {
          action: "read",
          threadId: priorAttempt.threadId,
          clientRequestId,
          expectedEnvironmentId: nativeEnvironmentId,
        },
        { home, exchange },
      );
      if (!receipt.messageSeen)
        return { taskRef, kind, status: "unknown", requestId: clientRequestId };
      created = { threadId: priorAttempt.threadId };
    } else if (!created && priorAttempt) {
      const listed = await native(
        { action: "list", expectedEnvironmentId: nativeEnvironmentId },
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
    } else if (!created) {
      await FSP.writeFile(journal, JSON.stringify({ kind, intent, requestId: clientRequestId }), {
        flag: previousNative ? "w" : "wx",
      });
      created = await native(
        {
          action: "create",
          expectedEnvironmentId: nativeEnvironmentId,
          ...configuration,
          title: task.title,
          clientRequestId,
          firstMessage: message,
          initialMessageId: Crypto.randomUUID(),
        },
        { home, exchange },
      );
    }
    if (!created.threadId) throw Error("Native creation outcome unknown; no duplicate creation.");
    if (input.requireQueue === true) {
      await command(board, [
        "task",
        "queue",
        "working",
        id,
        "--queue-request",
        input.queueRequest,
        "--request-id",
        input.reservationId,
        "--session-id",
        created.threadId,
      ]);
    } else {
      await command(board, ["task", "claim", "--agent", `t3:${created.threadId}`, id]);
    }
    if (task.live?.with_me) await command(board, ["task", "live", "start", id]);
    const resumed = !!(
      priorAttempt?.threadId ||
      (previousNative && created.threadId !== clientRequestId)
    );
    return {
      taskRef,
      status: resumed ? "opened" : "created",
      kind,
      threadId: created.threadId,
      sessionId: created.threadId,
      created: !resumed,
    };
  } finally {
    await FSP.rmdir(lock);
  }
}
