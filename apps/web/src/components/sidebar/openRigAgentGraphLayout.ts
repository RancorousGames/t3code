import { seatStatusTone } from "./openRigAgentPresentation";
import type { NetworkSeat, NetworkSession, TreeRow } from "./openRigNetwork";

/**
 * Pure placement for the agent network graph. Rows come from `flattenAgentTree`,
 * which already applied filtering, parent choice and cycle breaking; this turns
 * them into non-overlapping boxes plus the edges the model actually reports.
 * The tree grows DOWN: parents sit centred above their children and connectors
 * leave the bottom port and enter the top port.
 *  - delegates:      RigSpec delegation, along the placement the tree chose
 *  - also-delegates: additional RigSpec parents
 *  - spawned:        a managed session spawned from another seat
 * Seats outside the RigSpec topology get a compact grid BESIDE the tree and no edges.
 * While a manager is selected, its verified child sessions (a caller-supplied
 * prop, never invented here) are laid out as a temporary card grid in that
 * manager's subtree, so they are drawn without moving or mutating any seat.
 */

export const NODE_W = 240;
export const SIBLING_GAP = 24;
export const LEVEL_GAP = 64;
export const PAD = 24;
export const SESSION_PREVIEW = 3;
const ROOT_GAP = 40;
const SIDE_GAP = 72;
const GRID_GAP = 16;
const LANE_HEAD = 22;
const HEAD_H = 56;

export const CHILD_CARD_W = 200;
export const CHILD_CARD_H = 48;
const CHILD_GAP = 10;
const CHILD_HEAD = 20;
const CHILD_SPINE = 16;
const CHILD_MAX_COLS = 4;
const GROUP_GAP = 36;
const UNPLACED_MAX_COLS = 4;

/** A verified child session of a manager seat, supplied by the caller. */
export interface ChildSessionInput {
  id: string;
  /** Exact manager SEAT id. */
  parentId: string;
  title: string;
  status: string;
  working: boolean;
}

export interface LayoutOptions {
  /** Child cards are drawn only for this seat, and only if it is a visible manager. */
  selectedManagerId?: string | null;
  childSessions?: readonly ChildSessionInput[];
}

export interface ChildCard {
  session: ChildSessionInput;
  x: number;
  y: number;
  /** Connector from the manager's bottom port to this card's left port. */
  path: string;
}

export interface ChildGroup {
  managerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  /** Top-left of the unplaced grid, when it has seats. */
  unplacedTop: number | null;
  unplacedLeft: number;
  childGroup: ChildGroup | null;
  childCards: ChildCard[];
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

/**
 * `_availableWidth` is kept for call compatibility; the unplaced grid now sits
 * beside the tree, so the layout no longer depends on the viewport.
 */
export function layoutAgentGraph(
  rows: readonly TreeRow[],
  collapsed: ReadonlySet<string>,
  _availableWidth = 0,
  options: LayoutOptions = {},
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

  // Temporary child-session cards: selected manager only, exact parent seat id only.
  const manager = options.selectedManagerId ? nodes.get(options.selectedManagerId) : undefined;
  const cardSessions: ChildSessionInput[] = [];
  if (manager && seatKind(manager.seat) === "Manager") {
    const seen = new Set<string>();
    for (const session of options.childSessions ?? []) {
      if (session.parentId !== manager.seat.id || seen.has(session.id)) continue;
      seen.add(session.id);
      cardSessions.push(session);
    }
  }
  const groupCols = Math.min(
    CHILD_MAX_COLS,
    Math.max(1, Math.ceil(Math.sqrt(cardSessions.length))),
  );
  const groupRows = Math.ceil(cardSessions.length / groupCols);
  const groupW =
    cardSessions.length === 0
      ? 0
      : CHILD_SPINE + groupCols * CHILD_CARD_W + (groupCols - 1) * CHILD_GAP;
  const groupH =
    cardSessions.length === 0
      ? 0
      : CHILD_HEAD + groupRows * CHILD_CARD_H + (groupRows - 1) * CHILD_GAP;
  const groupFor = (id: string) => (manager && cardSessions.length > 0 && id === manager.seat.id ? groupW : 0);

  const extent = new Map<string, number>();
  const kidsWidth = (kids: readonly string[]) =>
    kids.reduce((sum, kid) => sum + extent.get(kid)!, 0) +
    Math.max(0, kids.length - 1) * SIBLING_GAP;
  /** Horizontal space a subtree needs: its children side by side, plus the temporary group. */
  const measure = (id: string): number => {
    const kids = visibleKids(nodes.get(id)!);
    kids.forEach(measure);
    const own = kidsWidth(kids);
    const group = groupFor(id);
    const value = Math.max(NODE_W, own + (own > 0 && group > 0 ? GROUP_GAP : 0) + group);
    extent.set(id, value);
    return value;
  };

  const order: string[] = [];
  const levelHeight: number[] = [];
  let groupSlot: { left: number; level: number } | null = null;
  const place = (id: string, left: number) => {
    const node = nodes.get(id)!;
    order.push(id);
    node.hidden = node.collapsed ? countAll(id) : 0;
    levelHeight[node.level] = Math.max(levelHeight[node.level] ?? 0, node.height);
    const total = extent.get(id)!;
    const kids = visibleKids(node);
    const group = groupFor(id);
    const own = kidsWidth(kids);
    const content = own + (own > 0 && group > 0 ? GROUP_GAP : 0) + group;
    const start = left + (total - content) / 2;
    if (kids.length === 0) {
      node.x = left + (total - NODE_W) / 2;
      if (group > 0) groupSlot = { left: start, level: node.level + 1 };
      return;
    }
    let cursor = start;
    for (const kid of kids) {
      place(kid, cursor);
      cursor += extent.get(kid)! + SIBLING_GAP;
    }
    const first = nodes.get(kids[0]!)!;
    const last = nodes.get(kids.at(-1)!)!;
    node.x = (first.x + last.x) / 2;
    if (group > 0) groupSlot = { left: start + own + GROUP_GAP, level: node.level + 1 };
  };

  const roots = rowOrder.filter((id) => nodes.get(id)!.parentId === null);
  const treeRoots = roots.filter((id) => nodes.get(id)!.seat.inTopology);
  const unplaced = roots.filter((id) => !nodes.get(id)!.seat.inTopology);

  let right = PAD;
  for (const root of treeRoots) {
    measure(root);
    place(root, right);
    right += extent.get(root)! + ROOT_GAP;
  }
  if (treeRoots.length > 0) right -= ROOT_GAP;

  // Every node in a level shares one top, so siblings align and connectors stay level.
  const slot = groupSlot as { left: number; level: number } | null;
  const levelCount = Math.max(levelHeight.length, slot ? slot.level + 1 : 0);
  const levelTop: number[] = [PAD];
  for (let level = 1; level < levelCount; level++)
    levelTop[level] = levelTop[level - 1]! + (levelHeight[level - 1] ?? 0) + LEVEL_GAP;
  let bottom = PAD;
  let width = PAD + NODE_W + PAD;
  for (const id of order) {
    const node = nodes.get(id)!;
    node.y = levelTop[node.level]!;
    bottom = Math.max(bottom, node.y + node.height);
    width = Math.max(width, node.x + NODE_W + PAD);
  }

  let childGroup: ChildGroup | null = null;
  const childCards: ChildCard[] = [];
  if (manager && slot && cardSessions.length > 0) {
    const top = levelTop[slot.level]!;
    childGroup = { managerId: manager.seat.id, x: slot.left, y: top, width: groupW, height: groupH };
    const mx = manager.x + NODE_W / 2;
    const my = manager.y + manager.height;
    const busY = my + 14;
    const spineX = slot.left + CHILD_SPINE / 2 - 2;
    cardSessions.forEach((session, index) => {
      const x = slot.left + CHILD_SPINE + (index % groupCols) * (CHILD_CARD_W + CHILD_GAP);
      const y = top + CHILD_HEAD + Math.floor(index / groupCols) * (CHILD_CARD_H + CHILD_GAP);
      childCards.push({
        session,
        x,
        y,
        path: `M${mx},${my} V${busY} H${spineX} V${y + CHILD_CARD_H / 2} H${x}`,
      });
    });
    bottom = Math.max(bottom, top + groupH);
    width = Math.max(width, slot.left + groupW + PAD);
  }

  // Unplaced seats have no known parent: a compact grid beside the tree, never edges.
  let unplacedTop: number | null = null;
  let unplacedLeft = PAD;
  if (unplaced.length > 0) {
    unplacedTop = PAD;
    unplacedLeft = treeRoots.length > 0 ? width - PAD + SIDE_GAP : PAD;
    const columns = Math.min(UNPLACED_MAX_COLS, Math.max(1, Math.ceil(Math.sqrt(unplaced.length))));
    const pitch = NODE_W + GRID_GAP;
    let rowTop = unplacedTop + LANE_HEAD;
    for (let start = 0; start < unplaced.length; start += columns) {
      let rowHeight = 0;
      unplaced.slice(start, start + columns).forEach((id, column) => {
        const node = nodes.get(id)!;
        node.x = unplacedLeft + column * pitch;
        node.y = rowTop;
        rowHeight = Math.max(rowHeight, node.height);
        width = Math.max(width, node.x + NODE_W + PAD);
        order.push(id);
      });
      bottom = Math.max(bottom, rowTop + rowHeight);
      rowTop += rowHeight + GRID_GAP;
    }
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
        active: seatStatusTone(node.seat.status ?? "") === "working",
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

  return {
    nodes,
    order,
    edges,
    width,
    height: bottom + PAD,
    unplacedTop,
    unplacedLeft,
    childGroup,
    childCards,
  };
}

/**
 * Connectors leave a bottom port and enter a top port. Delegation uses a shared
 * horizontal bus with rounded elbows so siblings read as one bracket; cross
 * links (also-delegates, spawned) are loose vertical curves, or a U-curve under
 * both boxes when they share a row.
 */
export function edgePath(from: GraphNode, to: GraphNode, kind: GraphEdge["kind"]) {
  const sx = from.x + NODE_W / 2;
  const sy = from.y + from.height;
  const tx = to.x + NODE_W / 2;
  const ty = to.y;
  if (ty > sy) {
    if (kind === "delegates") {
      const dx = tx - sx;
      if (Math.abs(dx) < 1) return `M${sx},${sy} V${ty}`;
      const busY = sy + (ty - sy) / 2;
      const dir = dx > 0 ? 1 : -1;
      const r = Math.min(8, Math.abs(dx) / 2, (ty - sy) / 2);
      return `M${sx},${sy} V${busY - r} Q${sx},${busY} ${sx + dir * r},${busY} H${tx - dir * r} Q${tx},${busY} ${tx},${busY + r} V${ty}`;
    }
    const bend = Math.max(28, (ty - sy) / 2);
    return `M${sx},${sy} C${sx},${sy + bend} ${tx},${ty - bend} ${tx},${ty}`;
  }
  const targetBottom = to.y + to.height;
  if (targetBottom < from.y) {
    // Target sits entirely above: leave the top port, enter the target's bottom port.
    const bend = Math.max(28, (from.y - targetBottom) / 2);
    return `M${sx},${from.y} C${sx},${from.y - bend} ${tx},${targetBottom + bend} ${tx},${targetBottom + 6}`;
  }
  // Same row: dip under both boxes and come back up into the target's bottom edge.
  const low = Math.max(sy, targetBottom) + 36;
  return `M${sx},${sy} C${sx},${low} ${tx},${low} ${tx},${targetBottom + 6}`;
}
