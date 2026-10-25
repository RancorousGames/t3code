import { seatStatusTone } from "./openRigAgentPresentation";
import type { NetworkSeat, NetworkSession, TreeRow } from "./openRigNetwork";

/**
 * Pure placement for the agent network graph. Rows come from `flattenAgentTree`,
 * which already applied filtering, parent choice and cycle breaking; this turns
 * them into non-overlapping boxes plus the edges the model actually reports:
 *  - delegates:      RigSpec delegation, along the placement the tree chose
 *  - also-delegates: additional RigSpec parents
 *  - spawned:        a managed session spawned from another seat
 * Seats outside the RigSpec topology get their own lane and no edges.
 */

export const NODE_W = 240;
export const COL_GAP = 72;
export const ROW_GAP = 14;
export const PAD = 24;
export const SESSION_PREVIEW = 3;
const LANE_GAP = 44;
const HEAD_H = 56;
const ROOT_GAP = 28;

export interface GraphNode {
  seat: NetworkSeat;
  /** Sessions that pass the current filter, primary first. */
  sessions: NetworkSession[];
  parentId: string | null;
  childIds: string[];
  alsoUnder: string[];
  level: number;
  x: number;
  y: number;
  height: number;
  /** Descendant seats hidden because this node is collapsed. */
  hidden: number;
  collapsed: boolean;
}

export interface GraphEdge {
  key: string;
  kind: "delegates" | "also-delegates" | "spawned";
  from: string;
  to: string;
  active: boolean;
}

export interface GraphLayout {
  nodes: Map<string, GraphNode>;
  /** Visible nodes in reading (and keyboard) order. */
  order: string[];
  edges: GraphEdge[];
  width: number;
  height: number;
  /** Top of the unplaced lane, when it has seats. */
  unplacedTop: number | null;
}

/**
 * Manager/worker comes from OpenRig's own seat role or real RigSpec delegation
 * children, never from the displayed name.
 */
export function seatKind(seat: NetworkSeat): "Manager" | "Worker" | "Unplaced" {
  if (!seat.inTopology) return "Unplaced";
  return seat.childIds.length > 0 || seat.role === "manager" || seat.role?.endsWith("-manager")
    ? "Manager"
    : "Worker";
}

export const nodeHeight = (sessions: number) =>
  HEAD_H +
  (sessions > 0
    ? 16 + Math.min(SESSION_PREVIEW, sessions) * 20 + (sessions > SESSION_PREVIEW ? 16 : 0)
    : 0);

export const seatActive = (node: Pick<GraphNode, "seat" | "sessions">) =>
  node.sessions.some((session) => session.active) ||
  seatStatusTone(node.seat.status ?? "") === "working";

export function layoutAgentGraph(
  rows: readonly TreeRow[],
  collapsed: ReadonlySet<string>,
  availableWidth: number,
): GraphLayout {
  const nodes = new Map<string, GraphNode>();
  const rowOrder: string[] = [];
  const stack: string[] = [];
  for (const row of rows) {
    if (row.kind === "session") {
      nodes.get(stack[row.depth - 1] ?? "")?.sessions.push(row.session);
      continue;
    }
    const parentId = row.depth > 0 ? (stack[row.depth - 1] ?? null) : null;
    stack.length = row.depth;
    stack.push(row.seat.id);
    nodes.set(row.seat.id, {
      seat: row.seat,
      sessions: [],
      parentId,
      childIds: [],
      alsoUnder: row.alsoUnder,
      level: row.depth,
      x: 0,
      y: 0,
      height: 0,
      hidden: 0,
      collapsed: collapsed.has(row.seat.id),
    });
    if (parentId) nodes.get(parentId)?.childIds.push(row.seat.id);
    rowOrder.push(row.seat.id);
  }
  for (const node of nodes.values()) node.height = nodeHeight(node.sessions.length);

  const countAll = (id: string): number =>
    (nodes.get(id)?.childIds ?? []).reduce((sum, child) => sum + 1 + countAll(child), 0);
  const visibleKids = (node: GraphNode) => (node.collapsed ? [] : node.childIds);
  const extent = new Map<string, number>();
  const spanOf = (kids: readonly string[]) =>
    kids.reduce((sum, kid) => sum + extent.get(kid)!, 0) + Math.max(0, kids.length - 1) * ROW_GAP;

  /** Vertical space a subtree needs: the wider of the node itself and its children stacked. */
  const measure = (id: string): number => {
    const node = nodes.get(id)!;
    const kids = visibleKids(node);
    kids.forEach(measure);
    const value = Math.max(node.height, spanOf(kids));
    extent.set(id, value);
    return value;
  };
  const order: string[] = [];
  const place = (id: string, top: number) => {
    const node = nodes.get(id)!;
    order.push(id);
    node.x = PAD + node.level * (NODE_W + COL_GAP);
    node.hidden = node.collapsed ? countAll(id) : 0;
    const own = extent.get(id)!;
    const kids = visibleKids(node);
    if (kids.length === 0) {
      node.y = top + (own - node.height) / 2;
      return;
    }
    let cursor = top + (own - spanOf(kids)) / 2;
    for (const kid of kids) {
      place(kid, cursor);
      cursor += extent.get(kid)! + ROW_GAP;
    }
    const first = nodes.get(kids[0]!)!;
    const last = nodes.get(kids.at(-1)!)!;
    const center = (first.y + first.height / 2 + last.y + last.height / 2) / 2;
    node.y = Math.min(Math.max(center - node.height / 2, top), top + own - node.height);
  };

  const roots = rowOrder.filter((id) => nodes.get(id)!.parentId === null);
  const treeRoots = roots.filter((id) => nodes.get(id)!.seat.inTopology);
  const unplaced = roots.filter((id) => !nodes.get(id)!.seat.inTopology);

  let bottom = PAD;
  let width = PAD * 2 + NODE_W;
  for (const root of treeRoots) {
    measure(root);
    place(root, bottom);
    bottom += extent.get(root)! + ROOT_GAP;
  }
  for (const id of order) width = Math.max(width, nodes.get(id)!.x + NODE_W + PAD);
  if (treeRoots.length > 0) bottom -= ROOT_GAP;

  // Unplaced seats have no known parent: a wrapping grid, never edges.
  let unplacedTop: number | null = null;
  if (unplaced.length > 0) {
    unplacedTop = treeRoots.length > 0 ? bottom + LANE_GAP : PAD;
    const pitch = NODE_W + COL_GAP / 2;
    const columns = Math.max(
      1,
      Math.floor((Math.max(availableWidth, width) - PAD * 2 + COL_GAP / 2) / pitch),
    );
    let rowTop = unplacedTop + 22;
    for (let start = 0; start < unplaced.length; start += columns) {
      let rowHeight = 0;
      unplaced.slice(start, start + columns).forEach((id, column) => {
        const node = nodes.get(id)!;
        node.x = PAD + column * pitch;
        node.y = rowTop;
        rowHeight = Math.max(rowHeight, node.height);
        width = Math.max(width, node.x + NODE_W + PAD);
        order.push(id);
      });
      rowTop += rowHeight + ROW_GAP;
    }
    bottom = rowTop - ROW_GAP;
  }

  const edges: GraphEdge[] = [];
  const linked = new Set<string>();
  const shown = new Set(order);
  for (const id of order) {
    const node = nodes.get(id)!;
    if (node.parentId && shown.has(node.parentId)) {
      edges.push({
        key: `d:${node.parentId}:${id}`,
        kind: "delegates",
        from: node.parentId,
        to: id,
        active: seatActive(node),
      });
      linked.add(`${node.parentId}\u0000${id}`);
    }
    for (const parent of node.alsoUnder)
      if (shown.has(parent)) {
        edges.push({
          key: `a:${parent}:${id}`,
          kind: "also-delegates",
          from: parent,
          to: id,
          active: false,
        });
        linked.add(`${parent}\u0000${id}`);
      }
  }
  for (const id of order)
    for (const session of nodes.get(id)!.sessions) {
      const from = session.spawnedFrom?.seatId;
      const pair = `${from}\u0000${id}`;
      if (!from || from === id || !shown.has(from) || linked.has(pair)) continue;
      linked.add(pair);
      edges.push({ key: `s:${from}:${id}`, kind: "spawned", from, to: id, active: session.active });
    }

  return { nodes, order, edges, width, height: bottom + PAD, unplacedTop };
}

/**
 * Delegation uses a shared vertical trunk with rounded elbows so siblings read
 * as one bracket; cross links (also-delegates, spawned) are loose curves.
 */
export function edgePath(from: GraphNode, to: GraphNode, kind: GraphEdge["kind"]) {
  const sx = from.x + NODE_W;
  const sy = from.y + from.height / 2;
  if (to.x > from.x) {
    const tx = to.x;
    const ty = to.y + to.height / 2;
    if (kind === "delegates") {
      const mx = sx + COL_GAP / 2;
      const dy = ty - sy;
      if (Math.abs(dy) < 1) return `M${sx},${sy} H${tx}`;
      const dir = dy > 0 ? 1 : -1;
      const r = Math.min(8, Math.abs(dy) / 2);
      return `M${sx},${sy} H${mx - r} Q${mx},${sy} ${mx},${sy + dir * r} V${ty - dir * r} Q${mx},${ty} ${mx + r},${ty} H${tx}`;
    }
    const bend = Math.max(28, (tx - sx) / 2);
    return `M${sx},${sy} C${sx + bend},${sy} ${tx - bend},${ty} ${tx},${ty}`;
  }
  // Same column or backwards (cross links): loop around the right side.
  const tx = to.x + NODE_W;
  const ty = to.y + to.height / 2;
  const reach = 48 + Math.abs(ty - sy) / 6;
  return `M${sx},${sy} C${sx + reach},${sy} ${tx + reach},${ty} ${tx + 6},${ty}`;
}
