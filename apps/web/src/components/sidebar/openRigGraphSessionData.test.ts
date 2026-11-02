import { describe, expect, it } from "vite-plus/test";
import type { BrowserSession } from "../../chatGPTBrowserSessions";
import { exactGraphSeatBrowserSessions, graphWorkerDescendants } from "./openRigGraphSessionData";
import type { AgentNetwork, LedgerResult, NetworkSeat } from "./openRigNetwork";

const seats = new Map<string, NetworkSeat>([
  ["manager", { id: "manager", name: "Manager", role: "manager", inTopology: true, childIds: ["worker"], parentIds: [] } as unknown as NetworkSeat],
  ["worker", { id: "worker", name: "Worker", role: "worker", inTopology: true, childIds: [], parentIds: ["manager"] } as unknown as NetworkSeat],
]);
const network = { seats } as unknown as AgentNetwork;

describe("Agent Network exact T3 browser session projection", () => {
  it("uses only existing browser slots explicitly attached in OpenRig ledger, prioritizing primary", () => {
    const browser: BrowserSession[] = [
      { id: "parent", title: "manager tab" },
      { id: "secondary", title: "older tab" },
    ];
    const ledgers = new Map<string, LedgerResult>([[
      "manager", { ok: true, ledger: {
        primarySessionId: "p",
        sessions: [
          { id: "old", attachedTabUuid: "secondary", target: null },
          { id: "p", attachedTabUuid: "parent", target: null },
          { id: "guess", attachedTabUuid: "not-a-real-slot", target: null },
        ],
      } as unknown as Extract<LedgerResult, { ok: true }>["ledger"] },
    ]]);
    expect(exactGraphSeatBrowserSessions(network, ledgers, browser).get("manager"))
      .toEqual(["parent", "secondary"]);
    expect(exactGraphSeatBrowserSessions(network, new Map(), browser).size).toBe(0);
  });

  it("shows backend-proven worker descendants only for a selected manager, independent of sidepanel visibility", () => {
    const browser: BrowserSession[] = [
      { id: "parent", title: "Manager" },
      { id: "child", title: "Working child", parentSessionId: "parent", spawnRequestId: "spawn-1", hidden: true },
      { id: "grandchild", title: "Nested child", parentSessionId: "child", spawnRequestId: "spawn-2" },
      { id: "manual", title: "Manually linked", parentSessionId: "parent" },
      { id: "unrelated", title: "Unrelated worker", parentSessionId: "other", spawnRequestId: "spawn-3" },
    ];
    const linked = new Map([["manager", ["parent"]]]);
    const children = graphWorkerDescendants(network, "manager", linked, browser);
    expect(children.map((child) => child.id)).toEqual(["child", "grandchild"]);
    expect(children[0]).toMatchObject({ status: "hidden", working: false, parentId: "manager" });
    expect(children[1]).toMatchObject({ status: "state unknown", working: false });
    expect(graphWorkerDescendants(network, "worker", linked, browser)).toEqual([]);
    expect(graphWorkerDescendants(network, null, linked, browser)).toEqual([]);
  });
});
