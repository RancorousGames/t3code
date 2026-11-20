import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ALIAS = /^[a-z][a-z0-9_-]{0,39}$/i;
const NATIVE_ID =
  /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|mcp:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|thread:mcp:(?:[A-Za-z0-9._~:-]|%[0-9a-f]{2}){1,240})$/i;
const rootDir = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "../../../../.t3/swarm");

export const defaultSwarmHome = () => Path.resolve(process.env.T3_SWARM_HOME || rootDir);

const demand = (condition, message) => {
  if (!condition) throw new Error(message);
};
const uuid = (value, label) => {
  demand(typeof value === "string" && UUID.test(value), label + " must be a UUID");
  return value.toLowerCase();
};
const alias = (value) => {
  demand(
    typeof value === "string" && ALIAS.test(value),
    "member alias must match [a-z][a-z0-9_-]{0,39}",
  );
  return value.toLowerCase();
};
const text = (value, field, max = 30000) => {
  demand(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
    field + " must be nonempty and at most " + max + " characters",
  );
  return value;
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const entryDir = (root, id) => Path.join(root, uuid(id, "swarmId"), "events");

async function getEvents(root, id) {
  const folder = entryDir(root, id);
  const names = await FS.readdir(folder).catch((error) => {
    if (error.code === "ENOENT") throw new Error("Swarm not found: " + id);
    throw error;
  });
  const events = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (name) => {
        const event = JSON.parse(await FS.readFile(Path.join(folder, name), "utf8"));
        demand(
          event && typeof event === "object" && typeof event.type === "string",
          "Invalid Swarm event " + name,
        );
        return event;
      }),
  );
  return events.sort((a, b) => {
    const clock = a.at.localeCompare(b.at);
    if (clock !== 0) return clock;
    // Keep rapid successive membership mutations in commit order even when
    // multiple events share the same millisecond timestamp.
    if (a.atNs && b.atNs && a.atNs !== b.atNs) {
      const aa = BigInt(a.atNs);
      const bb = BigInt(b.atNs);
      return aa < bb ? -1 : 1;
    }
    return a.key.localeCompare(b.key);
  });
}

// Immutable one-file-per-event board. A hard link publishes a complete temp
// atomically, without overwriting another process's event or losing a write.
async function append(root, id, key, event) {
  demand(/^[a-z0-9_-]{1,180}$/i.test(key), "Invalid event key");
  const folder = entryDir(root, id);
  await FS.mkdir(folder, { recursive: true });
  const target = Path.join(folder, key + ".json");
  const tmp = Path.join(folder, ".pending-" + Crypto.randomUUID());
  const value = {
    ...event,
    key,
    at: new Date().toISOString(),
    atNs: process.hrtime.bigint().toString(),
  };
  try {
    await FS.writeFile(tmp, JSON.stringify(value) + "\n", { flag: "wx" });
    try {
      await FS.link(tmp, target);
      return { value, created: true };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const prior = JSON.parse(await FS.readFile(target, "utf8"));
      const { at: _oldAt, atNs: _oldNs, ...oldFields } = prior;
      const { at: _newAt, atNs: _newNs, ...newFields } = value;
      demand(equal(oldFields, newFields), "Event ID already exists with different content: " + key);
      return { value: prior, created: false };
    }
  } finally {
    await FS.rm(tmp, { force: true });
  }
}

function project(events, swarmId) {
  const created = events.find((e) => e.type === "created");
  demand(created, "Swarm has no creation event: " + swarmId);
  const members = {};
  const messages = [];
  const wakes = {};
  const goals = {};
  const plans = {};
  const assignments = {};
  for (const e of events) {
    if (e.type === "member" || e.type === "member-set") members[e.member.alias] = e.member;
    if (e.type === "member-detached") delete members[e.alias];
    if (e.type === "message") messages.push(e);
    if (e.type === "goal") goals[e.goalId] = e;
    if (e.type === "team-plan") plans[e.goalId] = e;
    if (e.type === "assignment-slot") assignments[e.assignmentId] = { ...e, status: "reserved" };
    if (e.type === "assignment-attempt" && assignments[e.assignmentId])
      assignments[e.assignmentId].status = "uncertain";
    if (e.type === "assignment-outcome" && assignments[e.assignmentId]) {
      assignments[e.assignmentId].status = e.status;
      assignments[e.assignmentId].receipt = e.receipt;
    }
    if (e.type === "assignment-binding" && assignments[e.assignmentId])
      assignments[e.assignmentId].binding = e.binding;
    if (e.type === "wake-intent")
      wakes[e.key] = {
        id: e.key,
        messageId: e.messageId,
        target: e.target,
        message: e.notification,
        state: "pending",
        deliveryId: e.deliveryId,
        // Pin the original recipient; later rebindings must never redirect
        // historical notifications or their delivery receipt lookups.
        ...(e.recipient ? { recipient: e.recipient } : {}),
      };
  }
  for (const e of events) {
    if (e.type === "wake-attempt" && wakes[e.wakeId]) wakes[e.wakeId].state = "uncertain";
    if (e.type === "wake-result" && wakes[e.wakeId]) {
      wakes[e.wakeId].state = e.status;
      wakes[e.wakeId].detail = e.detail;
    }
  }
  return {
    id: swarmId,
    name: created.name,
    coordinator: created.coordinator ?? "Human operator",
    members,
    messages,
    wakes,
    goals,
    plans,
    assignments,
    events,
  };
}

const read = async (root, id) => project(await getEvents(root, id), id);

function notification(board, post, target) {
  return [
    `[T3 Swarm: ${board.name} | ${board.id}]`,
    `@${target} — ${post.author} mentioned you on the shared Swarm board.`,
    `Board message ID: ${post.messageId}`,
    "",
    post.body,
    "",
    "This is an event notification, not an autonomous agent spawn.",
    "ChatGPT: use t3_sessions with action=swarm and params.action=read/post to reply on this board.",
    "Native agents: use scripts/swarm.mjs, or your existing OMCP-T access.",
    "The board remains authoritative; direct messages still use ordinary T3 messaging.",
  ].join("\n");
}

async function wakeOnce(root, board, wakeId, transports) {
  const wake = board.wakes[wakeId];
  demand(wake, "Unknown wake event " + wakeId);
  if (wake.state !== "pending") return wake;
  // A previously acknowledged v1 event remains readable. Only unattempted
  // legacy wakes are blocked, because their original recipient was not pinned.
  demand(wake.recipient, "Wake recipient is unpinned; inspect the historical delivery manually");
  const member = wake.recipient;
  // No sender means no delivery could have occurred. Leave the intent pending
  // so a later explicit wake can use the existing T3 transport safely.
  const sender = member.kind === "native" ? transports?.native : transports?.chatgpt;
  if (typeof sender !== "function") {
    return { ...wake, detail: { error: "Delivery bridge unavailable; no attempt was made" } };
  }
  const attempt = await append(root, board.id, "attempt-" + wakeId, {
    type: "wake-attempt",
    wakeId,
  });
  if (!attempt.created) return (await read(root, board.id)).wakes[wakeId];
  let status = "uncertain";
  let detail;
  try {
    demand(transports, "Swarm delivery bridge is unavailable; no message sent.");
    const bridge = transports;
    if (member.kind === "native") {
      const receipt = await bridge.native({
        action: "send",
        threadId: member.threadId,
        ...(member.environmentId ? { expectedEnvironmentId: member.environmentId } : {}),
        clientRequestId: wake.deliveryId,
        message: wake.message,
      });
      demand(
        receipt?.threadId === member.threadId &&
          receipt?.messageId === wake.deliveryId &&
          receipt?.messageSent === true,
        "Native transport gave no exact send receipt",
      );
      status = "accepted";
      detail = {
        transport: "native",
        messageId: receipt.messageId,
        delivery: receipt.delivery ?? "queued-or-sent",
      };
    } else {
      const receipt = await bridge.chatgpt({
        action: "enqueue",
        messageId: wake.deliveryId,
        sessionId: member.sessionId,
        expectedConversationId: member.conversationId,
        message: wake.message,
      });
      demand(
        receipt?.messageId === wake.deliveryId &&
          receipt?.sessionId === member.sessionId &&
          receipt?.conversationId === member.conversationId &&
          typeof receipt.status === "string",
        "ChatGPT queue gave no exact durable enqueue receipt",
      );
      status = receipt.status;
      detail = { transport: "chatgpt", messageId: wake.deliveryId, status: receipt.status };
    }
  } catch (error) {
    // The transport may have committed before an error. Never resend automatically.
    detail = {
      error: String(error instanceof Error ? error.message : error),
      retry: "No automatic retry; reconcile by deliveryId.",
    };
  }
  await append(root, board.id, "result-" + wakeId, {
    type: "wake-result",
    wakeId,
    status,
    detail,
  });
  return (await read(root, board.id)).wakes[wakeId];
}

async function createIntent(root, board, post, memberName) {
  const target = alias(memberName);
  const key = "wake-" + post.messageId + "-" + target;
  const existing = board.events.find((event) => event.key === key);
  if (existing) return existing;
  demand(board.members[target], "Target not attached: " + target);
  const digest = Crypto.createHash("sha256")
    .update(board.id + ":" + post.messageId + ":" + target)
    .digest("hex");
  const deliveryId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const payload = {
    type: "wake-intent",
    messageId: post.messageId,
    target,
    deliveryId,
    notification: notification(board, post, target),
    recipient: board.members[target],
  };
  return (await append(root, board.id, key, payload)).value;
}

function workerHandoff(board, goal, assignment) {
  return [
    `[T3 Swarm: ${board.name} | ${board.id}]`,
    `Goal: ${goal.goal}`,
    `You are @${assignment.member}, assigned work ${assignment.assignmentId}.`,
    `Your distinct objective: ${assignment.title}`,
    assignment.task,
    "",
    "Work only on this assignment. Do not delegate further workers.",
    "Post progress/results on this board under your attached alias when available.",
    "Native: swarm_post_message / swarm_read_board. ChatGPT: OMCP-T t3_sessions.swarm.",
    "Your T3 session remains yours. The separate verifier/lifecycle will assess completion.",
  ].join("\n");
}

async function bindDelegatedWorker(root, board, assignment, receipt) {
  let binding;
  if (assignment.kind === "native" && receipt.childThreadId) {
    binding = { kind: "native", threadId: receipt.childThreadId };
  } else if (assignment.kind === "chatgpt" && receipt.chatgptSessionId) {
    const conversationId = /chatgpt\.com\/c\/([0-9a-f-]{36})/i.exec(receipt.link ?? "")?.[1];
    if (conversationId && UUID.test(conversationId)) {
      binding = {
        kind: "chatgpt",
        sessionId: receipt.chatgptSessionId,
        conversationId,
      };
    }
  }
  if (!binding) return null;
  await runSwarm(
    { action: "attach", swarmId: board.id, member: assignment.member, ...binding },
    { root, enabled: true },
  );
  await append(root, board.id, "binding-" + assignment.assignmentId, {
    type: "assignment-binding",
    assignmentId: assignment.assignmentId,
    binding,
  });
  return binding;
}

// Each irrevocable slot is an atomic event, shared by CLI and MCP readers. A
// second coordinator invocation cannot overbook even when both read the same log.
async function reserveSlot(root, board, goal, assignment) {
  const current = await read(root, board.id);
  if (current.assignments[assignment.assignmentId])
    return current.assignments[assignment.assignmentId];
  for (let slot = 1; slot <= goal.maxConcurrentWorkers; slot++) {
    try {
      const reserved = await append(root, board.id, "worker-slot-" + slot, {
        type: "assignment-slot",
        goalId: goal.goalId,
        assignmentId: assignment.assignmentId,
        member: assignment.member,
        slot,
        kind: assignment.kind,
        title: assignment.title,
      });
      if (reserved.value.assignmentId === assignment.assignmentId)
        return { ...reserved.value, status: "reserved" };
    } catch (error) {
      if (!String(error).includes("Event ID already exists with different content")) throw error;
    }
  }
  return null;
}

async function dispatchTeam(root, board, goalId, options) {
  const goal = board.goals[goalId];
  const plan = board.plans[goalId];
  demand(plan, "Coordinator must persist a mixed-team plan before dispatch");
  demand(typeof options.delegate === "function", "Authorized T3 delegation service unavailable");
  const results = [];
  for (const item of plan.assignments) {
    const latest = await read(root, board.id);
    const previous = latest.assignments[item.assignmentId];
    if (previous && previous.status !== "reserved") {
      results.push(previous);
      continue;
    }
    const reservation = await reserveSlot(root, latest, goal, item);
    if (!reservation) {
      results.push({ assignmentId: item.assignmentId, status: "capacity_waiting" });
      continue;
    }
    // Do not repeat a request after a possibly committed transport/delegation.
    // The reservation itself is retryable until its first attempted side effect.
    const attempted = await append(root, board.id, "assignment-attempt-" + item.assignmentId, {
      type: "assignment-attempt",
      assignmentId: item.assignmentId,
    });
    if (!attempted.created) {
      results.push((await read(root, board.id)).assignments[item.assignmentId]);
      continue;
    }
    let status = "uncertain";
    let receipt;
    try {
      const member = latest.members[item.member];
      if (member) {
        demand(member.kind === item.kind, "Attached worker type changed");
        const delivered = await runSwarm(
          {
            action: "post",
            swarmId: board.id,
            author: goal.coordinatorMember,
            messageId: item.assignmentId,
            body: workerHandoff(latest, goal, item),
            mentions: [item.member],
          },
          { root, enabled: true, transports: options.transports },
        );
        receipt = { kind: "reused", wake: delivered.wakes[0] };
        status = delivered.wakes[0]?.state === "uncertain" ? "uncertain" : "assigned";
      } else {
        const task = workerHandoff(latest, goal, item);
        const result = await options.delegate({
          clientRequestId: item.assignmentId,
          title: item.title,
          task,
          role: "implementation",
          isolation: "shared",
          mode: "async",
          ...(item.kind === "chatgpt"
            ? { target: { providerInstanceId: "chatgpt" } }
            : item.providerInstanceId
              ? { target: { providerInstanceId: item.providerInstanceId } }
              : {}),
        });
        demand(typeof result?.taskId === "string", "Delegation returned no task ID");
        receipt = {
          taskId: result.taskId,
          status: result.status,
          childThreadId: result.childThreadId ?? null,
          chatgptSessionId: result.chatgptSessionId ?? null,
          link: result.link ?? null,
        };
        try {
          receipt.binding = await bindDelegatedWorker(root, latest, item, result);
        } catch (error) {
          receipt.bindingError = String(error);
        }
        status = "delegated";
      }
    } catch (error) {
      receipt = {
        error: String(error instanceof Error ? error.message : error),
        guidance: "Outcome may already be committed. Reconcile IDs; do not redelegate.",
      };
    }
    await append(root, board.id, "assignment-outcome-" + item.assignmentId, {
      type: "assignment-outcome",
      assignmentId: item.assignmentId,
      status,
      receipt,
    });
    results.push((await read(root, board.id)).assignments[item.assignmentId]);
  }
  return { goalId, assignments: results, maxConcurrentWorkers: goal.maxConcurrentWorkers };
}

// Explicit read/bind only; verification and terminal-state transitions belong elsewhere.
async function syncTeam(root, board, goalId, options) {
  demand(typeof options.taskStatus === "function", "Authorized task status service unavailable");
  const results = [];
  for (const assignment of Object.values(board.assignments)) {
    if (
      assignment.goalId !== goalId ||
      assignment.binding ||
      assignment.kind !== "chatgpt" ||
      !assignment.receipt?.taskId
    )
      continue;
    try {
      const result = await options.taskStatus(assignment.receipt.taskId);
      const plan = board.plans[goalId]?.assignments.find(
        (item) => item.assignmentId === assignment.assignmentId,
      );
      if (!plan) continue;
      const binding = await bindDelegatedWorker(root, board, plan, result);
      results.push({ assignmentId: assignment.assignmentId, binding, taskStatus: result.status });
    } catch (error) {
      results.push({ assignmentId: assignment.assignmentId, error: String(error) });
    }
  }
  return { goalId, bindings: results };
}

/** Invoke explicitly; no server hook, watcher, scheduler or background sender. */
export async function runSwarm(input, options = {}) {
  demand(input && typeof input === "object" && !Array.isArray(input), "Expected JSON object");
  const root = Path.resolve(options.root || defaultSwarmHome());
  const action = text(input.action, "action", 30);
  const enabled = options.enabled === true;
  if (!["list", "read", "delivery"].includes(action)) {
    demand(enabled, "Swarm is OFF by default. Pass --enable or T3_SWARM_ENABLED=1 to mutate.");
  }
  if (action === "create") {
    const id = uuid(input.id ?? Crypto.randomUUID(), "id");
    const name = text(input.name, "name", 120);
    const coordinator = text(input.coordinator ?? "Human operator", "coordinator", 120);
    const created = await append(root, id, "create", { type: "created", name, coordinator });
    demand(
      created.value.name === name && created.value.coordinator === coordinator,
      "Conflicting existing swarm",
    );
    return { id, name, coordinator, created: created.created };
  }
  if (action === "list") {
    const folders = await FS.readdir(root, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const boards = [];
    for (const folder of folders) {
      if (!folder.isDirectory() || !UUID.test(folder.name)) continue;
      const board = await read(root, folder.name);
      boards.push({
        id: board.id,
        name: board.name,
        coordinator: board.coordinator,
        members: Object.keys(board.members).length,
        messages: board.messages.length,
      });
    }
    return { swarms: boards };
  }
  const swarmId = uuid(input.swarmId, "swarmId");
  const board = await read(root, swarmId);
  if (action === "goal") {
    const goalId = uuid(input.goalId, "goalId");
    const coordinatorMember = alias(input.coordinatorMember);
    const recipient = board.members[coordinatorMember];
    demand(recipient?.kind === "native", "Coordinator must be an attached native T3 thread");
    const goal = text(input.goal, "goal", 12000);
    const maxConcurrentWorkers = input.maxConcurrentWorkers;
    demand(
      Number.isInteger(maxConcurrentWorkers) &&
        maxConcurrentWorkers >= 2 &&
        maxConcurrentWorkers <= 12,
      "maxConcurrentWorkers must be 2..12 for a mixed native/ChatGPT team",
    );
    demand(
      Object.values(board.goals).every((other) => other.goalId === goalId),
      "This Swarm already has a goal; complete its lifecycle before starting another",
    );
    let created;
    try {
      created = await append(root, swarmId, "active-goal", {
        type: "goal",
        goalId,
        goal,
        maxConcurrentWorkers,
        coordinatorMember,
        recipient,
      });
    } catch (error) {
      if (String(error).includes("Event ID already exists with different content"))
        throw new Error("This Swarm already has a goal with different settings");
      throw error;
    }
    const prompt = [
      `Swarm coordinator goal ${goalId} on board ${swarmId}:`,
      goal,
      "",
      `Plan a team with distinct, non-overlapping assignments (at least one native T3 and one ChatGPT worker).`,
      `Max ${maxConcurrentWorkers} concurrent workers. Reuse an attached worker where appropriate; otherwise delegate through Swarm tools.`,
      `Call swarm_plan_team with this goalId and assignments, then swarm_dispatch_team.`,
      `Keep the board authoritative; never invoke delegate_task directly for this goal or bypass the Swarm cap.`,
      `Do not mark verification/completion: the separate lifecycle handles that. Do not change existing sessions.`,
    ].join("\n");
    const notice = await runSwarm(
      {
        action: "post",
        swarmId,
        messageId: goalId,
        author: "human",
        body: prompt,
        mentions: [coordinatorMember],
      },
      options,
    );
    return { goal: created.value, created: created.created, wakes: notice.wakes };
  }
  if (action === "plan" || action === "dispatch" || action === "sync") {
    const goalId = uuid(input.goalId, "goalId");
    const goal = board.goals[goalId];
    demand(goal, "Unknown Swarm goal");
    demand(
      options.coordinatorCaller?.threadId === goal.recipient.threadId &&
        (!goal.recipient.environmentId ||
          options.coordinatorCaller?.environmentId === goal.recipient.environmentId),
      "Only the goal's authenticated native coordinator may plan or dispatch",
    );
    demand(
      equal(board.members[goal.coordinatorMember], goal.recipient),
      "Coordinator detached or rebound; no delegation allowed",
    );
    if (action === "plan") {
      const assignments = input.assignments;
      demand(
        Array.isArray(assignments) && assignments.length >= 2 && assignments.length <= 24,
        "Plan needs 2..24 distinct assignments",
      );
      const normalized = assignments.map((item) => {
        demand(item && typeof item === "object", "Invalid assignment");
        const name = alias(item.member);
        demand(name !== goal.coordinatorMember, "Coordinator cannot be its own worker");
        demand(["native", "chatgpt"].includes(item.kind), "Worker kind must be native or chatgpt");
        demand(
          !board.members[name] || board.members[name].kind === item.kind,
          "Existing alias has a different worker kind",
        );
        if (item.kind === "native" && item.providerInstanceId !== undefined)
          text(item.providerInstanceId, "providerInstanceId", 64);
        demand(
          item.kind === "native" || item.providerInstanceId === undefined,
          "ChatGPT always uses the existing authorized browser delegation provider",
        );
        return {
          assignmentId: uuid(item.assignmentId, "assignmentId"),
          member: name,
          kind: item.kind,
          title: text(item.title, "title", 200),
          task: text(item.task, "task", 16000),
          ...(item.providerInstanceId ? { providerInstanceId: item.providerInstanceId } : {}),
        };
      });
      demand(
        new Set(normalized.map((item) => item.member)).size === normalized.length,
        "Duplicate worker alias in plan",
      );
      demand(
        new Set(normalized.map((item) => item.assignmentId)).size === normalized.length,
        "Duplicate assignment ID in plan",
      );
      demand(
        new Set(normalized.map((item) => item.task.trim().toLowerCase())).size ===
          normalized.length,
        "Team members need distinct work",
      );
      demand(
        normalized.some((item) => item.kind === "native") &&
          normalized.some((item) => item.kind === "chatgpt"),
        "A Swarm plan must include native and ChatGPT work",
      );
      const planned = await append(root, swarmId, "plan-" + goalId, {
        type: "team-plan",
        goalId,
        assignments: normalized,
      });
      return { plan: planned.value, created: planned.created };
    }
    if (action === "dispatch") {
      return dispatchTeam(root, await read(root, swarmId), goalId, options);
    }
    return syncTeam(root, await read(root, swarmId), goalId, options);
  }
  if (action === "attach") {
    const name = alias(input.member);
    demand(["native", "chatgpt"].includes(input.kind), "kind must be native or chatgpt");
    const member =
      input.kind === "native"
        ? {
            alias: name,
            kind: "native",
            threadId: input.threadId,
            ...(input.environmentId
              ? { environmentId: text(input.environmentId, "environmentId", 128) }
              : {}),
          }
        : {
            alias: name,
            kind: "chatgpt",
            sessionId: uuid(input.sessionId, "sessionId"),
            conversationId: uuid(input.conversationId, "conversationId"),
          };
    if (member.kind === "native") {
      demand(
        typeof member.threadId === "string" &&
          NATIVE_ID.test(member.threadId) &&
          !member.threadId.includes(".."),
        "Native thread ID not supported by T3 bridge",
      );
      if (!UUID.test(member.threadId))
        demand(member.environmentId, "Opaque native thread needs exact environmentId");
    }
    const current = board.members[name];
    if (current) {
      demand(
        equal(current, member),
        "Member is already attached to a different recipient; detach first",
      );
      return { member: current, attached: false };
    }
    // Keep original v1 attachment events readable. An alias can later be
    // reattached after a detach without overwriting its immutable history.
    const previouslyAttached = board.events.some(
      (event) =>
        (event.type === "member" || event.type === "member-set") && event.member.alias === name,
    );
    const key = previouslyAttached ? "member-set-" + Crypto.randomUUID() : "member-" + name;
    const inserted = await append(root, swarmId, key, {
      type: previouslyAttached ? "member-set" : "member",
      member,
    });
    return { member, attached: inserted.created };
  }
  if (action === "detach") {
    const name = alias(input.member);
    if (!board.members[name]) return { member: name, detached: false };
    await append(root, swarmId, "member-detached-" + Crypto.randomUUID(), {
      type: "member-detached",
      alias: name,
    });
    return { member: name, detached: true };
  }
  if (action === "post") {
    const author = input.author === "human" ? "human" : alias(input.author);
    const messageId = uuid(input.messageId ?? Crypto.randomUUID(), "messageId");
    const body = text(input.body, "body", 28000);
    const prior = board.messages.find((message) => message.messageId === messageId);
    demand(
      author === "human" || board.members[author] || prior?.author === author,
      "Author is not attached",
    );
    // Replays must preserve the original intent even if membership changes.
    // Explicit mentions are authoritative (including [] to suppress a wake).
    const mentions =
      input.mentions !== undefined
        ? input.mentions
        : prior?.author === author && prior.body === body
          ? prior.mentions
          : [...body.matchAll(/(^|[^a-z0-9_@])@([a-z][a-z0-9_-]{0,39})(?![a-z0-9_-])/gi)]
              .map((match) => match[2].toLowerCase())
              .filter((name) => board.members[name]);
    demand(
      Array.isArray(mentions) && mentions.length <= 20,
      "mentions must be a list of <=20 aliases",
    );
    const targets = [...new Set(mentions.map(alias))];
    if (!prior) {
      for (const target of targets) demand(board.members[target], "Target not attached: " + target);
    }
    const event = await append(root, swarmId, "message-" + messageId, {
      type: "message",
      messageId,
      author,
      body,
      mentions: targets,
    });
    const outcomes = [];
    for (const target of targets) {
      const current = await read(root, swarmId);
      const intent = await createIntent(root, current, event.value, target);
      const updated = await read(root, swarmId);
      outcomes.push(await wakeOnce(root, updated, intent.key, options.transports));
    }
    return { message: event.value, wakes: outcomes, created: event.created };
  }
  if (action === "wake") {
    const messageId = uuid(input.messageId, "messageId");
    const target = alias(input.member);
    const post = board.messages.find((e) => e.messageId === messageId);
    demand(post, "Cannot wake for a nonexistent board message");
    const intent = await createIntent(root, board, post, target);
    return {
      wake: await wakeOnce(root, await read(root, swarmId), intent.key, options.transports),
    };
  }
  if (action === "read") {
    const limit = input.limit ?? 100;
    demand(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, "read limit must be 1..500");
    const cursor =
      input.afterMessageId === undefined ? null : uuid(input.afterMessageId, "afterMessageId");
    const index =
      cursor === null ? null : board.messages.findIndex((message) => message.messageId === cursor);
    demand(index === null || index >= 0, "Message cursor not found in Swarm board");
    const messages =
      index === null
        ? board.messages.slice(-limit)
        : board.messages.slice(index + 1, index + 1 + limit);
    return {
      id: board.id,
      name: board.name,
      coordinator: board.coordinator,
      members: Object.values(board.members),
      messages,
      totalMessages: board.messages.length,
      nextAfterMessageId: messages.at(-1)?.messageId ?? cursor,
      hasMore: index !== null && index + 1 + messages.length < board.messages.length,
      wakes: input.includeWakes === false ? [] : Object.values(board.wakes),
      goals: Object.values(board.goals),
      plans: Object.values(board.plans),
      assignments: Object.values(board.assignments),
    };
  }
  if (action === "delivery") {
    const id = input.wakeId;
    const selected = Object.values(board.wakes).filter((wake) => !id || wake.id === id);
    demand(!id || selected.length === 1, "Unknown wakeId");
    const outcomes = [];
    for (const wake of selected) {
      const member = wake.recipient ?? board.members[wake.target];
      if (member?.kind !== "chatgpt" || wake.state === "pending") {
        outcomes.push(wake);
        continue;
      }
      try {
        demand(options.transports, "Swarm delivery bridge is unavailable.");
        const bridge = options.transports;
        const receipt = await bridge.chatgpt({
          action: "delivery_status",
          messageId: wake.deliveryId,
        });
        outcomes.push({ ...wake, liveReceipt: receipt });
      } catch (error) {
        outcomes.push({
          ...wake,
          statusCheckError: String(error instanceof Error ? error.message : error),
        });
      }
    }
    return { wakes: outcomes };
  }
  throw new Error(
    "action must be create, list, goal, plan, dispatch, sync, attach, detach, post, read, wake or delivery",
  );
}
