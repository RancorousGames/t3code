#!/usr/bin/env node
/**
 * Explicit manager-seat attachment for existing or newly created T3 ChatGPT
 * sessions. A browser title, spawn flag, or parent is never role evidence.
 * Only OpenRig's RigSpec role + unique ACTIVE PRIMARY ledger binding is.
 *
 * Input is JSON on stdin; no live session is mutated by action="inspect".
 * "attach" adopts an existing exact conversation. "create" preflights the seat
 * but rejects before mutation until first-turn reservation is supported.
 * No operation is automatically replayed after an UNKNOWN outcome.
 *
 * @typedef {{id:string,rigId:string,logicalId:string,role:string|null}} RigSeat
 * @typedef {{seatId:string,primarySessionId:string|null,sessions:Array<{
 * id:string,seatId:string,status:string,primary:boolean,mode:string,
 * attachedTabUuid?:string|null,target?:{kind:string,conversationId?:string}|null
 * }>}} SeatLedger
 * @typedef {{action:"inspect"|"attach"|"create"|"seat-create",seatId?:string,sessionId?:string,
 * conversationId?:string,expectedSpawnRequestId?:string,expectedLogicalId?:string,
 * operationId?:string,spawnRequestId?:string,title?:string,promptFile?:string,
 * parentSessionId?:string,project?:string,rigId?:string,logicalId?:string,role?:string,parentSeatId?:string}} ManagerSeatRequest
 */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { controlSessions } from "./chatgpt-sessions.mjs";

const API = "http://127.0.0.1:7433/api/integrations/t3";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const managerRoles = new Set(["global-manager", "project-manager"]);
const fail = (reason) => {
  throw new Error(reason);
};
const uuid = (value, label) =>
  UUID.test(value ?? "") ? value : fail(label + " requires a stable UUID.");

function exactT3Conversation(session, id, expectedConversationId, expectedSpawnRequestId) {
  if (!session || session.id !== id || session.hidden === true)
    fail("Exact visible T3 browser session unavailable; no adoption.");
  const fromUrl =
    /^https:\/\/chatgpt\.com\/c\/([0-9a-f-]{36})(?:[?#]|$)/i.exec(
      session.observedGuestUrl ?? "",
    )?.[1] ?? null;
  if (
    !fromUrl ||
    !UUID.test(fromUrl) ||
    session.conversationId !== fromUrl ||
    (expectedConversationId && fromUrl !== expectedConversationId)
  )
    fail("T3 observed conversation does not match the exact requested /c/ identity.");
  if (expectedSpawnRequestId && session.spawnRequestId !== expectedSpawnRequestId)
    fail("Spawn request correlation is absent or mismatched; do not infer it from title.");
  return fromUrl;
}

function primary(ledger) {
  if (!ledger || !Array.isArray(ledger.sessions)) fail("Incomplete managed OpenRig ledger.");
  const rows = ledger.sessions.filter((s) => s.primary === true);
  if (
    (ledger.primarySessionId === null && rows.length !== 0) ||
    (ledger.primarySessionId !== null &&
      (rows.length !== 1 || rows[0].id !== ledger.primarySessionId))
  )
    fail("Contradictory OpenRig PRIMARY ledger evidence.");
  return rows[0] ?? null;
}

/** Pure eligibility check. The only successful manager role source is RigSpec. */
export function planManagerSeatAttachment({
  topology,
  ledgers,
  seatId,
  sessionId,
  conversationId,
  expectedLogicalId,
}) {
  if (
    !topology ||
    !["openrig-rigspec", "openrig-rigspec-and-managed-ledger"].includes(topology.source) ||
    !Array.isArray(topology.seats) ||
    !Array.isArray(ledgers) ||
    ledgers.length !== topology.seats.length
  )
    fail("Complete RigSpec topology and ALL seat ledgers required.");
  const seatIds = new Set(topology.seats.map((s) => s.id));
  if (
    seatIds.size !== topology.seats.length ||
    new Set(ledgers.map((l) => l.seatId)).size !== seatIds.size ||
    ledgers.some((l) => !seatIds.has(l.seatId))
  )
    fail("Duplicate/incomplete seat evidence; refusing manager authority.");
  const seat = topology.seats.find((s) => s.id === seatId);
  if (!seat || !managerRoles.has(seat.role))
    fail("Requested seat has no explicit verified RigSpec manager role.");
  if (expectedLogicalId && seat.logicalId !== expectedLogicalId)
    fail("RigSpec logical manager seat does not match requested project.");
  if (
    topology.seats.some(
      (s) => s.id !== seatId && s.rigId === seat.rigId && s.logicalId === seat.logicalId,
    )
  )
    fail("Duplicate canonical manager logical seat; resolve in OpenRig.");
  const own = ledgers.find((l) => l.seatId === seatId);
  for (const ledger of ledgers) {
    const active = ledger.sessions.filter(
      (s) =>
        s.status === "active" &&
        s.target?.kind === "chatgpt-conversation" &&
        (s.target.conversationId === conversationId || s.attachedTabUuid === sessionId),
    );
    if (ledger.seatId !== seatId && active.length)
      fail("Conversation or browser already owned by another OpenRig seat.");
  }
  const current = primary(own);
  if (current) {
    if (
      current.status === "active" &&
      current.seatId === seatId &&
      current.target?.kind === "chatgpt-conversation" &&
      current.target.conversationId === conversationId &&
      current.attachedTabUuid === sessionId
    )
      return {
        kind: "already_attached",
        seatId,
        managedSessionId: current.id,
        role: seat.role,
        conversationId,
        sessionId,
      };
    fail("Manager seat already has another PRIMARY; never reassign it implicitly.");
  }
  if (
    own.sessions.some(
      (s) =>
        s.status === "active" &&
        s.target?.kind === "chatgpt-conversation" &&
        (s.target.conversationId === conversationId || s.attachedTabUuid === sessionId),
    )
  )
    fail("Existing non-primary manager binding requires explicit OpenRig reconciliation.");
  return { kind: "adopt", seatId, role: seat.role, conversationId, sessionId };
}

/** Read-only manager-seat preflight, also used BEFORE any new manager spawn. */
export async function inspectManagerSeat(input, services) {
  const topology = await services.topology();
  const ledgers = await Promise.all(topology.seats.map((s) => services.ledger(s.id)));
  const plan = planManagerSeatAttachment({
    topology,
    ledgers,
    seatId: input.seatId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    expectedLogicalId: input.expectedLogicalId,
  });
  return plan;
}

/** OpenRig adoption persists across T3 unmount/reconnect and same-slot reboot.
 * Reboots change the conversation, requiring OpenRig's own same-seat rollover
 * transaction; a stale old conversation must not be auto-re-adopted. */
export async function attachManagerSeat(input, services) {
  const operationId = uuid(input.operationId, "operationId");
  const sessionId = uuid(input.sessionId, "sessionId");
  const session = await services.session(sessionId);
  const conversationId = exactT3Conversation(
    session,
    sessionId,
    input.conversationId,
    input.expectedSpawnRequestId,
  );
  const plan = await inspectManagerSeat(
    {
      seatId: input.seatId,
      sessionId,
      conversationId,
      expectedLogicalId: input.expectedLogicalId,
    },
    services,
  );
  if (plan.kind === "already_attached")
    return { ...plan, persisted: true, changed: false, operationId: null };
  // Adoption can succeed even if the response is lost. No automatic replay.
  const receipt = await services.adopt(input.seatId, operationId, {
    kind: "chatgpt-conversation",
    conversationId,
    preferredBrowserSessionId: sessionId,
  });
  if (
    receipt?.seatId !== input.seatId ||
    receipt?.session?.operationId !== operationId ||
    receipt?.session?.seatId !== input.seatId ||
    receipt?.session?.mode !== "adopt"
  )
    fail("Adoption outcome UNKNOWN; read the exact seat ledger; never retry blindly.");
  const after = await inspectManagerSeat(
    {
      seatId: input.seatId,
      sessionId,
      conversationId,
      expectedLogicalId: input.expectedLogicalId,
    },
    services,
  );
  if (after.kind !== "already_attached" || after.managedSessionId !== receipt.session.id)
    fail("Adoption persistence/PRIMARY unconfirmed; inspect ledger before any replay.");
  return { ...after, persisted: true, changed: true, operationId };
}

/** Preflight only: current T3 spawn sends before a /c/ identity can be adopted.
 * Never send a bootstrap prompt to manufacture manager evidence. Re-enable
 * creation only when a supported reserve/bind/first-dispatch contract exists. */
export async function createManagerSeatSession(input, services) {
  uuid(input.operationId, "operationId");
  uuid(input.spawnRequestId, "spawnRequestId");
  if (input.parentSessionId) uuid(input.parentSessionId, "parentSessionId");
  if (!input.title?.trim() || !input.promptFile?.trim())
    fail("create needs title and existing UTF-8 promptFile.");
  // For create, there is no T3 identity yet. The sentinel never grants a role.
  const topology = await services.topology();
  const seat = topology.seats.find((s) => s.id === input.seatId);
  if (
    !seat ||
    !managerRoles.has(seat.role) ||
    (input.expectedLogicalId && seat.logicalId !== input.expectedLogicalId)
  )
    fail("No exact canonical RigSpec manager seat to create into.");
  const ledgers = await Promise.all(topology.seats.map((s) => services.ledger(s.id)));
  if (
    ledgers.length !== topology.seats.length ||
    new Set(ledgers.map((l) => l.seatId)).size !== ledgers.length ||
    new Set(topology.seats.map((s) => s.id)).size !== topology.seats.length ||
    ledgers.some((l) => !topology.seats.some((s) => s.id === l.seatId))
  )
    fail("Incomplete seat evidence.");
  if (
    topology.seats.some(
      (s) => s.id !== seat.id && s.rigId === seat.rigId && s.logicalId === seat.logicalId,
    )
  )
    fail("Duplicate canonical manager logical seat; reconcile before create.");
  const own = ledgers.find((l) => l.seatId === input.seatId);
  if (
    primary(own) ||
    own.sessions.some(
      (s) => s.status === "pending" || s.status === "indeterminate" || s.status === "active",
    )
  )
    fail("Manager seat already occupied or pending; reconcile rather than spawn a duplicate.");
  fail(
    "Manager first-turn creation unsupported: T3 spawn dispatches the prompt before " +
      "OpenRig can verify an exact conversation/tab PRIMARY. No session created, task " +
      "dispatched, or creation reserved. Requires a supported reserve/bind/first-dispatch " +
      "contract; do not send a bootstrap prompt or retry through ordinary spawn.",
  );
}

/** RigSpec-only creation, no ChatGPT/thread/browser/initial message side effects. */
export async function createManagerSeatOnly(input, provider) {
  uuid(input.operationId, "operationId");
  if (
    !input.rigId?.trim() ||
    !input.logicalId?.trim() ||
    !managerRoles.has((input.role ?? "").toLowerCase())
  )
    fail("Explicit manager role, rigId and logicalId required; no seat created.");
  const receipt = await provider.provision({
    operationId: input.operationId,
    rigId: input.rigId,
    logicalId: input.logicalId,
    role: input.role,
    ...(input.label ? { label: input.label } : {}),
    ...(input.parentSeatId ? { parentSeatId: input.parentSeatId } : {}),
  });
  if (
    !receipt?.seatId ||
    receipt.createdExecution !== false ||
    receipt.operationId !== input.operationId ||
    !["created", "already_created"].includes(receipt.state)
  )
    fail("Seat creation outcome UNKNOWN; inspect the exact operationId before retry.");
  return receipt;
}

async function request(path, data) {
  const response = await fetch(API + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Accept: "application/json",
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail("OpenRig HTTP " + response.status + " " + path);
  return response.json();
}

const services = {
  provision: (input) => request("/coordination/seats/create", input),
  topology: () => request("/coordination/discover"),
  ledger: (seatId) => request("/agents/" + encodeURIComponent(seatId) + "/sessions"),
  session: async (sessionId) => {
    const result = await controlSessions({ action: "list", which: "all", includeHidden: true });
    const matching = (result.sessions ?? []).filter((s) => s.id === sessionId);
    if (matching.length !== 1) fail("T3 session missing or duplicated.");
    return matching[0];
  },
  adopt: (seatId, operationId, target) =>
    request("/agents/" + encodeURIComponent(seatId) + "/sessions/assign-existing", {
      operationId,
      t3SessionId: target.preferredBrowserSessionId,
      expectedConversationId: target.conversationId,
      expectedPrimaryManagedSessionId: null,
    }),
};

export async function main(input) {
  if (!input || !["inspect", "attach", "create", "seat-create"].includes(input.action))
    fail("Require action inspect|attach|create|seat-create.");
  if (input.action === "seat-create") return createManagerSeatOnly(input, services);
  if (!input.seatId?.trim()) fail("Exact seatId is required.");
  if (input.action === "inspect") {
    uuid(input.sessionId, "sessionId");
    const session = await services.session(input.sessionId);
    const conversationId = exactT3Conversation(
      session,
      input.sessionId,
      input.conversationId,
      input.expectedSpawnRequestId,
    );
    return inspectManagerSeat({ ...input, conversationId }, services);
  }
  if (input.action === "attach") return attachManagerSeat(input, services);
  return createManagerSeatSession(input, services);
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 100_000) fail("Oversized manager attach request.");
  }
  try {
    const input = JSON.parse(raw.replace(/^\uFEFF/u, ""));
    process.stdout.write(JSON.stringify(await main(input)) + "\n");
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) +
        "\n",
    );
    process.exitCode = 1;
  }
}
