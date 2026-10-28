import assert from "node:assert/strict";
import test from "node:test";
import {
  planManagerSeatAttachment, attachManagerSeat, createManagerSeatSession,
  createManagerSeatOnly,
} from "./openrig-manager-seat.mjs";

const MANAGER = "01M5AA0AAAAAAAAAAAAAAAAAAA";
const WORKER = "01M5BB0BBBBBBBBBBBBBBBBBBB";
const TAB = "7d73c7cc-0d17-4dba-a7b7-b60424bf3e9b";
const CONVERSATION = "6adf941e-9e98-83eb-8288-ad96526fe708";
const SPAWN = "c3f41bc8-5df5-4d59-81e1-273069951594";
const OP = "18b45f2c-ade8-4a9b-b81f-aed013537032";
const TOPOLOGY = {
  source: "openrig-rigspec-and-managed-ledger",
  seats: [
    { id: MANAGER, rigId: "rig-omni", logicalId: "projects.omni", role: "project-manager" },
    { id: WORKER, rigId: "rig-omni", logicalId: "workers.test", role: "worker" },
  ],
};
const empty = seatId => ({ seatId, primarySessionId: null, sessions: [] });
const active = () => ({
  id: "managed-001", seatId: MANAGER, primary: true, status: "active",
  mode: "adopt", attachedTabUuid: TAB,
  target: { kind: "chatgpt-conversation", conversationId: CONVERSATION },
});
const browser = () => ({
  id: TAB, conversationId: CONVERSATION,
  observedGuestUrl: "https://chatgpt.com/c/" + CONVERSATION,
  parentSessionId: "75a6ef99-1f30-4ac3-afe2-4ced0ad7a849",
  spawnRequestId: SPAWN, hidden: false,
  title: "Not trusted as a role",
});
const input = {
  seatId: MANAGER, sessionId: TAB, conversationId: CONVERSATION,
  operationId: OP, expectedSpawnRequestId: SPAWN, expectedLogicalId: "projects.omni",
};

test("seat-create provisions identity without spawning a browser conversation", async () => {
  let launches = 0;
  let provisionCalls = 0;
  const operationId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const input = { operationId, rigId: "rig-omni", logicalId: "projects.omni",
    role: "project-manager", label: "Omni Project Manager" };
  const response = await createManagerSeatOnly(input, {
    provision: async payload => {
      provisionCalls++;
      assert.deepEqual(payload, input);
      return { state: "created", seatId: MANAGER, operationId, createdExecution: false };
    },
    spawn: async () => { launches++; throw Error("No spawn may happen"); },
  });
  assert.equal(response.seatId, MANAGER);
  assert.equal(provisionCalls, 1);
  assert.equal(launches, 0);
  await assert.rejects(createManagerSeatOnly({ ...input, role: "worker" },
    { provision: async () => { throw Error("Invalid role admitted"); } }),
    /Explicit manager role/);
});

test("verified manager attach persists one primary without changing independent child lineage", async () => {
  let managerLedger = empty(MANAGER);
  let adoptCalls = 0;
  const child = browser();
  const services = {
    topology: async () => TOPOLOGY,
    ledger: async id => id === MANAGER ? managerLedger : empty(WORKER),
    session: async () => child,
    adopt: async (seatId, operationId, target) => {
      adoptCalls++;
      assert.equal(seatId, MANAGER);
      assert.equal(operationId, OP);
      assert.deepEqual(target, { kind: "chatgpt-conversation",
        conversationId: CONVERSATION, preferredBrowserSessionId: TAB });
      managerLedger = { seatId: MANAGER, primarySessionId: "managed-001",
        sessions: [active()] };
      return { seatId: MANAGER, session: { ...active(), operationId: OP } };
    },
  };
  const first = await attachManagerSeat(input, services);
  assert.equal(first.changed, true);
  assert.equal(first.managedSessionId, "managed-001");
  const second = await attachManagerSeat(input, services);
  assert.equal(second.changed, false);
  assert.equal(adoptCalls, 1);
  assert.equal(child.parentSessionId, "75a6ef99-1f30-4ac3-afe2-4ced0ad7a849");
});

test("another primary or other owner rejects duplicate manager attach", () => {
  const own = { seatId: MANAGER, primarySessionId: "occupied",
    sessions: [{ ...active(), id: "occupied",
      target: { kind: "chatgpt-conversation", conversationId:
        "6adebb1b-423c-83ed-9e67-070d92aa5bf2" } }] };
  assert.throws(() => planManagerSeatAttachment({
    topology: TOPOLOGY, ledgers: [own, empty(WORKER)],
    seatId: MANAGER, sessionId: TAB, conversationId: CONVERSATION,
  }), /another PRIMARY/);
  assert.throws(() => planManagerSeatAttachment({
    topology: TOPOLOGY,
    ledgers: [empty(MANAGER), { seatId: WORKER, primarySessionId: "owned",
      sessions: [{ ...active(), id: "owned", seatId: WORKER }] }],
    seatId: MANAGER, sessionId: TAB, conversationId: CONVERSATION,
  }), /owned by another/);
});

test("stale/unknown seat role and ordinary backend child cannot assert manager", async () => {
  for (const role of [null, "worker", "worker-manager"]) {
    const topology = { ...TOPOLOGY, seats: [{ ...TOPOLOGY.seats[0], role },
      TOPOLOGY.seats[1]] };
    assert.throws(() => planManagerSeatAttachment({
      topology, ledgers: [empty(MANAGER), empty(WORKER)],
      seatId: MANAGER, sessionId: TAB, conversationId: CONVERSATION,
    }), /no explicit verified RigSpec manager role/);
  }
  const services = {
    topology: async () => TOPOLOGY,
    ledger: async id => empty(id),
    session: async () => ({ ...browser(), spawnRequestId: "wrong" }),
    adopt: async () => assert.fail("No adoption on invalid correlation"),
  };
  await assert.rejects(attachManagerSeat(input, services), /Spawn request correlation/);
});

test("create refuses occupied manager before spawning a second T3 session", async () => {
  let called = false;
  await assert.rejects(createManagerSeatSession({
    ...input, title: "Requested manager", promptFile: "instructions.md",
    spawnRequestId: SPAWN,
  }, {
    topology: async () => TOPOLOGY,
    ledger: async id => id === MANAGER ? {
      seatId: MANAGER, primarySessionId: "managed-001", sessions: [active()],
    } : empty(id),
    spawn: async () => { called = true; },
  }), /already occupied/);
  assert.equal(called, false);
});

test("read-only preflight rejects incomplete RigSpec/ledger and duplicate logical seats", () => {
  assert.throws(() => planManagerSeatAttachment({
    topology: TOPOLOGY, ledgers: [empty(MANAGER)],
    seatId: MANAGER, sessionId: TAB, conversationId: CONVERSATION,
  }), /Complete RigSpec/);
  const duplicate = { ...TOPOLOGY, seats: [...TOPOLOGY.seats,
    { ...TOPOLOGY.seats[0], id: "another-seat" }] };
  assert.throws(() => planManagerSeatAttachment({
    topology: duplicate,
    ledgers: [empty(MANAGER), empty(WORKER), empty("another-seat")],
    seatId: MANAGER, sessionId: TAB, conversationId: CONVERSATION,
  }), /Duplicate canonical manager logical seat/);
});


test("explicit manager create reserves once, keeps parent lineage and attaches verified PRIMARY", async () => {
  const parent = "75a6ef99-1f30-4ac3-afe2-4ced0ad7a849";
  const browserChild = { ...browser(), parentSessionId: parent };
  let managerLedger = empty(MANAGER);
  let reserves = 0;
  let spawns = 0;
  const services = {
    topology: async () => TOPOLOGY,
    ledger: async id => id === MANAGER ? managerLedger : empty(WORKER),
    reserveCreation: async (seatId, operationId, spawnRequestId) => {
      reserves++;
      assert.deepEqual([seatId, operationId, spawnRequestId], [MANAGER, OP, SPAWN]);
    },
    spawn: async request => {
      spawns++;
      assert.equal(request.requestId, SPAWN);
      assert.equal(request.parentSessionId, parent);
      return { requestId: SPAWN, created: true, outcome: "delivered",
        sessionId: TAB, parentConfirmation: "confirmed", parentSessionId: parent };
    },
    session: async () => browserChild,
    adopt: async (seatId, operationId) => {
      managerLedger = { seatId: MANAGER, primarySessionId: "managed-001",
        sessions: [active()] };
      return { seatId, session: { ...active(), operationId } };
    },
  };
  const request = { ...input, title: "Manager", promptFile: "instructions.md",
    spawnRequestId: SPAWN, parentSessionId: parent };
  assert.equal((await createManagerSeatSession(request, services)).persisted, true);
  await assert.rejects(createManagerSeatSession(request, services), /already occupied/);
  assert.deepEqual([reserves, spawns, browserChild.parentSessionId], [1, 1, parent]);
});

test("UNKNOWN manager create cannot replay a reserved spawn, and wrong parent cannot adopt", async () => {
  const parent = "75a6ef99-1f30-4ac3-afe2-4ced0ad7a849";
  let reserved = false;
  let spawns = 0;
  let adopts = 0;
  const services = {
    topology: async () => TOPOLOGY,
    ledger: async id => empty(id),
    reserveCreation: async () => {
      if (reserved) throw new Error("Manager create already reserved");
      reserved = true;
    },
    spawn: async () => { spawns++; return {
      requestId: SPAWN, created: true, outcome: "created", sessionId: TAB,
      parentConfirmation: "mismatch", parentSessionId: null,
    }; },
    adopt: async () => { adopts++; },
  };
  const request = { ...input, title: "Manager", promptFile: "instructions.md",
    spawnRequestId: SPAWN, parentSessionId: parent };
  await assert.rejects(createManagerSeatSession(request, services), /parent lineage unconfirmed/);
  await assert.rejects(createManagerSeatSession(request, services), /already reserved/);
  assert.deepEqual([spawns, adopts], [1, 0]);
});
