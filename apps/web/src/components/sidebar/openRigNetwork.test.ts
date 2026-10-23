import type { DesktopOpenRigAgent, DesktopOpenRigManagedSession, DesktopOpenRigSeatSessions, DesktopOpenRigSeatTopology } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildAgentNetwork, flattenAgentTree, type NetworkThreadInput, type NetworkFilter } from "./openRigNetwork";

const agents: DesktopOpenRigAgent[] = [
  { id: "seat/a", name: "Manager", status: "busy", role: "lead", task: "Coordinate", bound: false, bindingKind: null, sessionId: null, sessionTitle: null },
  { id: "seat/b", name: "Worker", status: "idle", role: "worker", task: "Implement", bound: false, bindingKind: null, sessionId: null, sessionTitle: null },
];
const topology: DesktopOpenRigSeatTopology = {
  source: "openrig-rigspec",
  seats: [
    { id: "seat/a", name: "Manager", role: "lead", rigId: "rig", rigName: "Test Rig", logicalId: "a", parentIds: [], childIds: ["seat/b"] },
    { id: "seat/b", name: "Worker", role: "worker", rigId: "rig", rigName: "Test Rig", logicalId: "b", parentIds: ["seat/a"], childIds: [] },
  ],
};
function session(): DesktopOpenRigManagedSession {
  return {
    id: "managed-1", seatId: "seat/a", operationId: "00000000-0000-4000-8000-000000000001",
    mode: "native", status: "active", primary: true, target: { kind: "t3-thread", environmentId: "local", threadId: "parent-thread" },
    targetKey: "native:parent-thread", projectId: "proj", environmentId: "local", threadId: "parent-thread",
    conversationId: null, attachedTabUuid: null, parentSeatId: null, parentManagedSessionId: null,
    provenance: "managed", intent: { title: "Owned parent session", modelSelection: { model: "gpt-6-astra" } },
    createdAt: "2026-10-18T12:00:00Z", updatedAt: "2026-10-18T12:04:00Z",
    error: null, observed: { available: true, status: "idle" }, modelCompletionVerified: false,
  };
}
function ledger(sessions: DesktopOpenRigManagedSession[]): DesktopOpenRigSeatSessions {
  return {
    version: 1, seatId: "seat/a", primarySessionId: sessions[0]?.id ?? null,
    sessions, legacyBinding: null, legacyAutoImported: false, pendingRecoveryCount: 0,
    launchPolicy: {
      explicitOperationIdRequired: true, duplicateOperationRetrySafe: false,
      automaticUnknownRetry: false, implicitAdoption: false,
    },
  };
}
function thread(id: string, parent: string | null, model: string): NetworkThreadInput {
  return {
    id, environmentId: "local", projectId: "proj", title: id,
    providerInstanceId: "codex", modelSelection: { model, options: { reasoningEffort: "high" } },
    runtime: { status: "idle" }, lineage: { parentThreadId: parent, relationshipToParent: parent ? "subagent" : null },
    createdAt: "2026-10-18T12:01:00Z", updatedAt: "2026-10-18T12:03:00Z", archivedAt: null,
  };
}
const filter: NetworkFilter = { query: "", activeOnly: false, costlyOnly: false, rigId: "", model: "", costlyPatterns: ["astra"] };

describe("OpenRig agent network evidence boundaries", () => {
  it("keeps RigSpec delegation separate from verified managed ownership and T3 subagent ancestry", () => {
    const n = buildAgentNetwork({
      agents, topology,
      ledgers: new Map([
        ["seat/a", { ok: true as const, ledger: ledger([session()]) }],
        ["seat/b", { ok: true as const, ledger: { ...ledger([]), seatId: "seat/b" } }],
      ]),
      threads: [thread("parent-thread", null, "gpt-6-astra"), thread("child-thread", "parent-thread", "gpt-6")],
      costlyPatterns: ["astra"],
    });
    expect(n.seats.get("seat/b")?.parentIds).toEqual(["seat/a"]);
    expect(n.seats.get("seat/a")?.sessions[0]?.seatId).toBe("seat/a");
    expect(n.seats.get("seat/b")?.sessions).toHaveLength(0);
    expect(n.unattributed).toHaveLength(1);
    expect(n.unattributed[0]?.threadId).toBe("child-thread");
    expect(n.unattributed[0]?.t3Parent).toMatchObject({ threadId: "parent-thread", ownerSeatId: "seat/a", relationship: "subagent" });
    expect(n.events.map(e => e.title)).toEqual(expect.arrayContaining([expect.stringContaining("session created"), expect.stringContaining("ledger active")]));
    expect(n.events.every(e => !/communicat|messag|approval|spend|\$/iu.test(e.title))).toBe(true);
    expect(n.modelUsage.find(e => e.model === "gpt-6-astra")?.costly).toBe(true);
    expect(n.modelUsage.find(e => e.model === "gpt-6")?.unattributed).toBe(1);
    expect(flattenAgentTree(n, new Set(["seat/a", "seat/b"]), filter).map(r => r.key))
      .toEqual(["seat:seat/a", "managed:seat/a:managed-1", "seat:seat/b"]);
  });

  it("an unreadable ledger does not turn inferred T3 parent links into owned session data", () => {
    const n = buildAgentNetwork({
      agents, topology, ledgers: new Map([["seat/a", { ok: false as const, error: "Service unavailable" }]]),
      threads: [thread("parent-thread", null, "gpt-6-astra")], costlyPatterns: ["astra"],
    });
    expect(n.unreadLedgers).toBe(2);
    expect(n.unattributed).toHaveLength(1);
    expect(n.unattributed[0]?.seatId).toBeNull();
    expect(n.seats.get("seat/a")?.ledgerError).toContain("unavailable");
    expect(n.events).toEqual([]);
  });

  it("does not project a relationship solely from identical names or parent threads", () => {
    const n = buildAgentNetwork({ agents, topology: null, ledgers: new Map(), threads: [thread("child-thread", "parent-thread", "gpt-6")], costlyPatterns: [] });
    expect(n.topologyAvailable).toBe(false);
    expect(n.seats.get("seat/b")?.parentIds).toEqual([]);
    expect(n.unattributed[0]?.t3Parent?.ownerSeatId).toBeNull();
  });

  it("filters costly models by actual model label, not a guessed dollar price", () => {
    const n = buildAgentNetwork({ agents, topology, ledgers: new Map([["seat/a", { ok: true as const, ledger: ledger([session()]) }]]), threads: [], costlyPatterns: ["astra"] });
    const rows = flattenAgentTree(n, new Set(["seat/a", "seat/b"]), { ...filter, costlyOnly: true });
    expect(rows.some(r => r.kind === "session" && r.session.model === "gpt-6-astra")).toBe(true);
    expect(rows.some(r => r.kind === "seat" && r.seat.id === "seat/b")).toBe(false);
  });
});
