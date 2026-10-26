import { describe, expect, it } from "vite-plus/test";
import {
  CHILD_CARD_H,
  CHILD_CARD_W,
  layoutAgentGraph,
  NODE_W,
  type ChildSessionInput,
} from "./openRigAgentGraphLayout";
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

const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const baseRows = [
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
  seatRow(seat("lost2", [], [], false), 0),
];

describe("layoutAgentGraph", () => {
  it("grows the tree downward without overlap, with orphans in a grid beside it", () => {
    const layout = layoutAgentGraph(baseRows, new Set(), 900);
    const boxes = layout.order.map((id) => {
      const n = layout.nodes.get(id)!;
      return { id, x: n.x, y: n.y, w: NODE_W, h: n.height };
    });
    expect(boxes).toHaveLength(7);
    for (const a of boxes) {
      expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
      for (const b of boxes) if (a !== b) expect(overlaps(a, b)).toBe(false);
    }
    const node = (id: string) => layout.nodes.get(id)!;
    // Children sit below their parent, centred under it for a lone child.
    expect(node("wt").y).toBeGreaterThanOrEqual(node("omni").y + node("omni").height);
    expect(node("w3").y).toBeGreaterThanOrEqual(node("wt").y + node("wt").height);
    expect(node("w3").x).toBe(node("wt").x);
    // Orphans are entirely to the right of every tree node and start at the top.
    const treeRight = Math.max(...["omni", "wt", "w3", "w2", "solo"].map((id) => node(id).x + NODE_W));
    for (const id of ["lost", "lost2"]) expect(node(id).x).toBeGreaterThan(treeRight);
    expect(layout.unplacedTop).toBe(node("lost").y - 22);
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`).sort()).toEqual([
      "omni>w2",
      "omni>wt",
      "wt>w3",
    ]);
  });

  describe("child session cards", () => {
    const child = (id: string, parentId: string): ChildSessionInput => ({
      id,
      parentId,
      title: id,
      status: "idle",
      working: false,
    });
    const many = Array.from({ length: 11 }, (_, i) => child(`c${i}`, "omni"));

    it("draws only for the selected manager's exact children, without overlap", () => {
      const sessions = [...many, child("other", "wt"), child("dup", "omni"), child("dup", "omni")];
      const layout = layoutAgentGraph(baseRows, new Set(), 900, {
        selectedManagerId: "omni",
        childSessions: sessions,
      });
      expect(layout.childCards.map((card) => card.session.id)).toEqual([
        ...many.map((s) => s.id),
        "dup",
      ]);
      const rects = [
        ...layout.order.map((id) => {
          const n = layout.nodes.get(id)!;
          return { x: n.x, y: n.y, w: NODE_W, h: n.height };
        }),
        ...layout.childCards.map((c) => ({ x: c.x, y: c.y, w: CHILD_CARD_W, h: CHILD_CARD_H })),
      ];
      rects.forEach((a, i) =>
        rects.forEach((b, j) => {
          if (i !== j) expect(overlaps(a, b)).toBe(false);
        }),
      );
      // Seats do not move or gain edges when cards appear.
      expect(layout.edges).toHaveLength(3);
    });

    it("draws nothing when the selection is not a manager or has no children", () => {
      for (const selectedManagerId of ["w2", "lost", "nope", null]) {
        const layout = layoutAgentGraph(baseRows, new Set(), 900, {
          selectedManagerId,
          childSessions: many,
        });
        expect(layout.childCards).toEqual([]);
        expect(layout.childGroup).toBeNull();
      }
    });
  });
});
