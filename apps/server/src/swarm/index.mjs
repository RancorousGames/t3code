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
  return events.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

// Immutable one-file-per-event board. A hard link publishes a complete temp
// atomically, without overwriting another process's event or losing a write.
async function append(root, id, key, event) {
  demand(/^[a-z0-9_-]{1,180}$/i.test(key), "Invalid event key");
  const folder = entryDir(root, id);
  await FS.mkdir(folder, { recursive: true });
  const target = Path.join(folder, key + ".json");
  const tmp = Path.join(folder, ".pending-" + Crypto.randomUUID());
  const value = { ...event, key, at: new Date().toISOString() };
  try {
    await FS.writeFile(tmp, JSON.stringify(value) + "\n", { flag: "wx" });
    try {
      await FS.link(tmp, target);
      return { value, created: true };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const prior = JSON.parse(await FS.readFile(target, "utf8"));
      const { at: _oldAt, ...oldFields } = prior;
      const { at: _newAt, ...newFields } = value;
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
  for (const e of events) {
    if (e.type === "member") members[e.member.alias] = e.member;
    if (e.type === "message") messages.push(e);
    if (e.type === "wake-intent")
      wakes[e.key] = {
        id: e.key,
        messageId: e.messageId,
        target: e.target,
        message: e.notification,
        state: "pending",
        deliveryId: e.deliveryId,
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
    "Read/post on the same board with scripts/swarm.mjs and the above swarmId.",
    "The board remains authoritative; reply there when you have local CLI access.",
  ].join("\n");
}

async function wakeOnce(root, board, wakeId, transports) {
  const wake = board.wakes[wakeId];
  demand(wake, "Unknown wake event " + wakeId);
  const member = board.members[wake.target];
  demand(member, "Missing target member " + wake.target);
  if (wake.state !== "pending") return wake;
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
  demand(board.members[target], "Target not attached: " + target);
  const key = "wake-" + post.messageId + "-" + target;
  const existing = board.events.find((event) => event.key === key);
  if (existing) return existing;
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
  };
  return (await append(root, board.id, key, payload)).value;
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
    const inserted = await append(root, swarmId, "member-" + name, { type: "member", member });
    return { member, attached: inserted.created };
  }
  if (action === "post") {
    const author = input.author === "human" ? "human" : alias(input.author);
    demand(author === "human" || board.members[author], "Author is not attached");
    const messageId = uuid(input.messageId ?? Crypto.randomUUID(), "messageId");
    const body = text(input.body, "body", 28000);
    const mentions = input.mentions ?? [];
    demand(
      Array.isArray(mentions) && mentions.length <= 20,
      "mentions must be a list of <=20 aliases",
    );
    const targets = [...new Set(mentions.map(alias))];
    for (const target of targets) demand(board.members[target], "Target not attached: " + target);
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
    return {
      id: board.id,
      name: board.name,
      coordinator: board.coordinator,
      members: Object.values(board.members),
      messages: board.messages.slice(-Math.min(500, Math.max(1, input.limit ?? 100))),
      wakes: Object.values(board.wakes),
    };
  }
  if (action === "delivery") {
    const id = input.wakeId;
    const selected = Object.values(board.wakes).filter((wake) => !id || wake.id === id);
    demand(!id || selected.length === 1, "Unknown wakeId");
    const outcomes = [];
    for (const wake of selected) {
      const member = board.members[wake.target];
      if (member.kind !== "chatgpt" || wake.state === "pending") {
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
  throw new Error("action must be create, list, attach, post, read, wake or delivery");
}
