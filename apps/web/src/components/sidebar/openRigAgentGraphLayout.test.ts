import { describe, expect, it } from "vite-plus/test";
import { layoutAgentGraph, NODE_W } from "./openRigAgentGraphLayout";
import type { NetworkSeat, TreeRow } from "./openRigNetwork";

const seat = (id: string, parentIds: string[], childIds: string[], inTopology = true) =>
  ({
    id,
    name: id,
    role: null,
    status: "idle",
    parentIds,
    childIds,
    inTopology,
  }) as unknown as NetworkSeat;
const seatRow = (s: NetworkSeat, depth: number) =>
  ({ kind: "seat", seat: s, depth, alsoUnder: [] }) as unknown as TreeRow;
const sessionRow = (key: string, depth: number) =>
  ({ kind: "session", session: { key }, depth }) as unknown as TreeRow;

describe("layoutAgentGraph", () => {
  // Regression: subtree extents were never measured, so every position was NaN and cards stacked with no edges.
  it("places finite, non-overlapping nodes and links each child to its parent", () => {
    const rows = [
      seatRow(seat("omni", [], ["wt", "w2"]), 0),
      sessionRow("1", 1),
      sessionRow("2", 1),
      sessionRow("3", 1),
      seatRow(seat("wt", ["omni"], ["w3"]), 1),
      sessionRow("4", 2),
      sessionRow("5", 2),
      seatRow(seat("w3", ["wt"], []), 2),
      seatRow(seat("w2", ["omni"], []), 1),
      sessionRow("6", 2),
      seatRow(seat("solo", [], []), 0),
      seatRow(seat("lost", [], [], false), 0),
    ];
    const layout = layoutAgentGraph(rows, new Set(), 900);
    const boxes = layout.order.map((id) => layout.nodes.get(id)!);
    expect(boxes).toHaveLength(6);
    for (const a of boxes) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
      for (const b of boxes)
        if (a !== b)
          expect(
            a.x < b.x + NODE_W &&
              b.x < a.x + NODE_W &&
              a.y < b.y + b.height &&
              b.y < a.y + a.height,
          ).toBe(false);
    }
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual([
      "omni>w2",
      "omni>wt",
      "wt>w3",
    ]);
  });
});
