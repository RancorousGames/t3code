import {
  AlertTriangleIcon,
  BotIcon,
  CircleDashedIcon,
  MinusIcon,
  PlusIcon,
  ScanIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "../ui/button";
import { SEAT_STATUS_DOT, seatStatusTone, type SeatStatusTone } from "./openRigAgentPresentation";
import type { AgentNetwork, NetworkSeat, NetworkSession, TreeRow } from "./openRigNetwork";

/**
 * Left-to-right 2D drawing of the seat tree that `flattenAgentTree` produced.
 * Placement, filtering and cycle handling stay in the model; this file only
 * turns rows into boxes and draws the edges the model actually reports:
 *  - solid:  RigSpec delegation, along the placement the tree chose
 *  - dashed: additional RigSpec parents ("also delegated by")
 *  - dotted: a managed session spawned from another seat
 * Seats outside the RigSpec topology get their own lane and no edges.
 */

const NODE_W = 248;
const COL_GAP = 72;
const ROW_GAP = 14;
const LANE_GAP = 44;
const PAD = 24;
const SESSION_PREVIEW = 3;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.5;

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

const nodeHeight = (sessions: number) =>
  62 + (sessions > 0 ? 10 + Math.min(SESSION_PREVIEW, sessions) * 20 + (sessions > SESSION_PREVIEW ? 16 : 0) : 0);

const seatActive = (node: Pick<GraphNode, "seat" | "sessions">) =>
  node.sessions.some((session) => session.active) || seatStatusTone(node.seat.status ?? "") === "working";

export function layoutAgentGraph(
  rows: readonly TreeRow[],
  collapsed: ReadonlySet<string>,
  availableWidth: number,
): GraphLayout {
  // Rebuild parent/child structure from the flattened rows, which already
  // carry the model's placement, filtering and cycle breaking.
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
      seat: row.seat, sessions: [], parentId, childIds: [], alsoUnder: row.alsoUnder,
      level: row.depth, x: 0, y: 0, height: 0, hidden: 0, collapsed: collapsed.has(row.seat.id),
    });
    if (parentId) nodes.get(parentId)?.childIds.push(row.seat.id);
    rowOrder.push(row.seat.id);
  }
  for (const node of nodes.values()) node.height = nodeHeight(node.sessions.length);

  const countAll = (id: string): number =>
    (nodes.get(id)?.childIds ?? []).reduce((sum, child) => sum + 1 + countAll(child), 0);
  const visibleKids = (node: GraphNode) => (node.collapsed ? [] : node.childIds);
  const spanOf = (kids: readonly string[]) =>
    kids.reduce((sum, kid) => sum + extent.get(kid)!, 0) + Math.max(0, kids.length - 1) * ROW_GAP;

  const extent = new Map<string, number>();
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
    place(root, bottom);
    bottom += extent.get(root)! + ROW_GAP * 2;
  }
  for (const id of order) width = Math.max(width, nodes.get(id)!.x + NODE_W + PAD);

  // Unplaced seats have no known parent: a wrapping grid, never edges.
  let unplacedTop: number | null = null;
  if (unplaced.length > 0) {
    unplacedTop = treeRoots.length > 0 ? bottom - ROW_GAP * 2 + LANE_GAP : PAD;
    const pitch = NODE_W + COL_GAP / 2;
    const columns = Math.max(1, Math.floor((Math.max(availableWidth, width) - PAD * 2 + COL_GAP / 2) / pitch));
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
    bottom = rowTop + ROW_GAP * 2;
  }

  const edges: GraphEdge[] = [];
  const linked = new Set<string>();
  const shown = new Set(order);
  for (const id of order) {
    const node = nodes.get(id)!;
    if (node.parentId && shown.has(node.parentId)) {
      edges.push({ key: `d:${node.parentId}:${id}`, kind: "delegates", from: node.parentId, to: id, active: seatActive(node) });
      linked.add(`${node.parentId}\u0000${id}`);
    }
    for (const parent of node.alsoUnder)
      if (shown.has(parent)) {
        edges.push({ key: `a:${parent}:${id}`, kind: "also-delegates", from: parent, to: id, active: false });
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

  return { nodes, order, edges, width, height: Math.max(bottom - ROW_GAP * 2 + PAD, PAD * 2), unplacedTop };
}

function edgePath(from: GraphNode, to: GraphNode) {
  if (to.x > from.x) {
    const sx = from.x + NODE_W;
    const sy = from.y + from.height / 2;
    const tx = to.x;
    const ty = to.y + to.height / 2;
    const bend = Math.max(28, (tx - sx) / 2);
    return `M${sx},${sy} C${sx + bend},${sy} ${tx - bend},${ty} ${tx},${ty}`;
  }
  // Same column or backwards (cross links): loop around the right side.
  const sx = from.x + NODE_W;
  const sy = from.y + from.height / 2;
  const tx = to.x + NODE_W;
  const ty = to.y + to.height / 2;
  const reach = 48 + Math.abs(ty - sy) / 6;
  return `M${sx},${sy} C${sx + reach},${sy} ${tx + reach},${ty} ${tx + 6},${ty}`;
}

const TONE_FRAME: Record<SeatStatusTone, string> = {
  working: "border-info/60 ring-[3px] ring-info/12",
  waiting: "border-warning/60",
  blocked: "border-destructive/60 bg-destructive/[0.04]",
  idle: "border-border",
  offline: "border-border opacity-75",
  unknown: "border-border",
};

const TONE_LABEL: Partial<Record<SeatStatusTone, { text: string; className: string }>> = {
  working: { text: "Active", className: "bg-info/12 text-info" },
  waiting: { text: "Waiting", className: "bg-warning/14 text-warning-foreground" },
  blocked: { text: "Blocked", className: "bg-destructive/12 text-destructive-foreground" },
};

export function OpenRigAgentGraph({
  network,
  rows,
  collapsed,
  selectedId,
  emptyText,
  onToggle,
  onSelect,
  onOpenAgent,
}: {
  network: AgentNetwork;
  rows: readonly TreeRow[];
  collapsed: ReadonlySet<string>;
  selectedId: string | null;
  emptyText: string;
  onToggle: (id: string, open?: boolean) => void;
  onSelect: (id: string) => void;
  onOpenAgent: (seatId: string) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [focusId, setFocusId] = useState<string | null>(null);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    setViewportWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setViewportWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => layoutAgentGraph(rows, collapsed, viewportWidth || 900),
    [rows, collapsed, viewportWidth],
  );
  // Fit shrinks wide trees to the viewport width; it never enlarges small ones.
  const fitScale = viewportWidth > 0 ? Math.min(1, Math.max(MIN_ZOOM, viewportWidth / layout.width)) : 1;
  const scale = zoom === "fit" ? fitScale : zoom;
  const stepZoom = (delta: number) =>
    setZoom(Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale + delta)) * 10) / 10);

  const activeFocus = focusId && layout.nodes.has(focusId) ? focusId : (layout.order[0] ?? null);
  const focusNode = (id: string | undefined | null) => {
    if (!id) return;
    setFocusId(id);
    viewportRef.current?.querySelector<HTMLElement>(`[data-seat-id="${CSS.escape(id)}"]`)?.focus();
  };
  useEffect(() => {
    if (selectedId) setFocusId(selectedId);
  }, [selectedId]);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const node = activeFocus ? layout.nodes.get(activeFocus) : undefined;
    if (!node || !activeFocus) return;
    const index = layout.order.indexOf(activeFocus);
    const expandable = node.childIds.length > 0;
    switch (event.key) {
      case "ArrowDown": focusNode(layout.order[Math.min(layout.order.length - 1, index + 1)]); break;
      case "ArrowUp": focusNode(layout.order[Math.max(0, index - 1)]); break;
      case "Home": focusNode(layout.order[0]); break;
      case "End": focusNode(layout.order.at(-1)); break;
      case "ArrowRight":
        if (expandable && node.collapsed) onToggle(activeFocus, true);
        else focusNode(node.childIds[0]);
        break;
      case "ArrowLeft":
        if (expandable && !node.collapsed) onToggle(activeFocus, false);
        else focusNode(node.parentId);
        break;
      case "Enter": onOpenAgent(activeFocus); break;
      case " ": onSelect(activeFocus); break;
      default: return;
    }
    event.preventDefault();
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewportRef}
        className="absolute inset-0 overflow-auto overscroll-contain"
        style={{
          backgroundImage: "radial-gradient(color-mix(in srgb, var(--muted-foreground) 20%, transparent) 1px, transparent 1px)",
          backgroundSize: `${20 * scale}px ${20 * scale}px`,
        }}
      >
        {layout.order.length === 0 ? (
          <p className="px-3 py-10 text-center text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          <div className="pb-12" style={{ width: layout.width * scale, height: layout.height * scale }}>
            <div
              role="tree"
              aria-label="OpenRig seats and their delegation"
              className="relative origin-top-left"
              style={{ width: layout.width, height: layout.height, transform: scale === 1 ? undefined : `scale(${scale})` }}
              onKeyDown={keyDown}
            >
              <svg aria-hidden className="pointer-events-none absolute inset-0 overflow-visible" width={layout.width} height={layout.height}>
                <defs>
                  {(["muted", "info"] as const).map((name) => (
                    <marker key={name} id={`openrig-graph-arrow-${name}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6"
                      orient="auto" className={name === "info" ? "text-info/75" : "text-muted-foreground/55"}>
                      <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                    </marker>
                  ))}
                </defs>
                {layout.edges.map((edge) => {
                  const info = edge.kind === "spawned" || edge.active;
                  const tone = info ? "text-info/75" : edge.kind === "also-delegates" ? "text-muted-foreground/40" : "text-muted-foreground/55";
                  return (
                    <path
                      key={edge.key}
                      d={edgePath(layout.nodes.get(edge.from)!, layout.nodes.get(edge.to)!)}
                      className={tone}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={edge.kind === "delegates" ? 1.6 : 1.25}
                      strokeDasharray={edge.kind === "also-delegates" ? "6 5" : edge.kind === "spawned" ? "1.5 4" : undefined}
                      strokeLinecap="round"
                      markerEnd={`url(#openrig-graph-arrow-${info ? "info" : "muted"})`}
                    />
                  );
                })}
              </svg>
              {layout.unplacedTop !== null && (
                <div
                  className="absolute flex items-center gap-2 text-3xs font-semibold tracking-wide text-muted-foreground uppercase"
                  style={{ left: PAD, top: layout.unplacedTop, right: PAD }}
                >
                  <CircleDashedIcon className="size-3" aria-hidden />
                  {network.topologyAvailable ? "Outside RigSpec topology · no parent known" : "Seat hierarchy unavailable · no links guessed"}
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              {layout.order.map((id) => (
                <SeatNode
                  key={id}
                  node={layout.nodes.get(id)!}
                  focused={id === activeFocus}
                  selected={id === selectedId}
                  seatName={(seatId) => network.seats.get(seatId)?.name ?? seatId}
                  onFocus={() => setFocusId(id)}
                  onSelect={() => onSelect(id)}
                  onToggle={() => onToggle(id)}
                  onOpenAgent={() => onOpenAgent(id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
        <GraphLegend />
        <div className="pointer-events-auto ml-auto flex items-center rounded-lg border border-border bg-popover/95 shadow-sm">
          <Button size="icon-xs" variant="ghost-muted" aria-label="Zoom out" onClick={() => stepZoom(-0.1)}>
            <MinusIcon aria-hidden />
          </Button>
          <button
            type="button"
            className="min-w-11 px-1 text-center text-3xs font-medium text-muted-foreground tabular-nums hover:text-foreground"
            aria-label={zoom === "fit" ? `Fitted to width at ${Math.round(scale * 100)}%` : "Fit graph to width"}
            title="Fit to width"
            onClick={() => setZoom("fit")}
          >
            {zoom === "fit" ? (
              <span className="inline-flex items-center gap-1"><ScanIcon className="size-3" aria-hidden />{Math.round(scale * 100)}%</span>
            ) : `${Math.round(scale * 100)}%`}
          </button>
          <Button size="icon-xs" variant="ghost-muted" aria-label="Zoom in" onClick={() => stepZoom(0.1)}>
            <PlusIcon aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

function GraphLegend() {
  const line = (dash: string | undefined, className: string) => (
    <svg aria-hidden width="22" height="6" className={className}>
      <path d="M1,3 H21" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  );
  return (
    <div className="pointer-events-auto hidden flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-popover/95 px-2.5 py-1.5 text-3xs text-muted-foreground shadow-sm sm:flex">
      <span className="inline-flex items-center gap-1">{line(undefined, "text-muted-foreground/70")}Delegates</span>
      <span className="inline-flex items-center gap-1">{line("5 4", "text-muted-foreground/60")}Also delegated by</span>
      <span className="inline-flex items-center gap-1">{line("1.5 3.5", "text-info/80")}Spawned session</span>
      <span className="inline-flex items-center gap-1"><UsersRoundIcon className="size-3" aria-hidden />Manager</span>
      <span className="inline-flex items-center gap-1"><BotIcon className="size-3" aria-hidden />Worker</span>
      <span className="inline-flex items-center gap-1"><CircleDashedIcon className="size-3" aria-hidden />Unplaced</span>
    </div>
  );
}

function SeatNode({
  node, focused, selected, seatName, onFocus, onSelect, onToggle, onOpenAgent,
}: {
  node: GraphNode;
  focused: boolean;
  selected: boolean;
  seatName: (id: string) => string;
  onFocus: () => void;
  onSelect: () => void;
  onToggle: () => void;
  onOpenAgent: () => void;
}) {
  const { seat, sessions } = node;
  const tone = seatActive(node) ? "working" : seatStatusTone(seat.status ?? "");
  const toneLabel = TONE_LABEL[tone];
  // Manager/worker comes only from real RigSpec delegation edges.
  const kind = !seat.inTopology ? "Unplaced" : seat.childIds.length > 0 ? "Manager" : "Worker";
  const KindIcon = kind === "Manager" ? UsersRoundIcon : kind === "Worker" ? BotIcon : CircleDashedIcon;
  const expandable = node.childIds.length > 0;
  const activeCount = sessions.filter((session) => session.active).length;
  return (
    <div
      role="treeitem"
      aria-level={node.level + 1}
      aria-selected={selected}
      aria-expanded={expandable ? !node.collapsed : undefined}
      aria-label={`Seat ${seat.name}, ${kind.toLowerCase()}, ${seat.status ?? "not in agent list"}`}
      data-seat-id={seat.id}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onClick={onSelect}
      onDoubleClick={onOpenAgent}
      className={`absolute flex cursor-pointer flex-col rounded-xl border bg-card px-3 py-2 text-left shadow-xs transition-[box-shadow,border-color] hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring ${TONE_FRAME[tone]} ${seat.inTopology ? "" : "border-dashed"} ${selected ? "outline-2 outline-offset-2 outline-primary" : "outline-none"}`}
      style={{ left: node.x, top: node.y, width: NODE_W, height: node.height }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-md ${kind === "Manager" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
          aria-hidden
        >
          <KindIcon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{seat.name}</span>
        {seat.ledger === "failed" && (
          <span title={`Ledger unreadable: ${seat.ledgerError ?? ""}`}>
            <AlertTriangleIcon className="size-3.5 text-warning" aria-label="Ledger unreadable" />
          </span>
        )}
        {toneLabel ? (
          <span className={`shrink-0 rounded-full px-1.5 py-px text-3xs font-semibold ${toneLabel.className}`}>{toneLabel.text}</span>
        ) : (
          <span className={`size-2 shrink-0 rounded-full ${SEAT_STATUS_DOT[tone]}`} aria-hidden />
        )}
      </span>
      <span className="mt-0.5 flex min-w-0 items-center gap-1 pl-8 text-3xs text-muted-foreground">
        <span className="shrink-0 font-medium text-foreground/70">{kind}</span>
        {seat.role && <span className="truncate">· {seat.role.replaceAll("-", " ")}</span>}
        <span className="truncate">· {seat.status ?? "not in agent list"}</span>
      </span>
      <span className="mt-0.5 truncate pl-8 text-3xs text-muted-foreground">
        {sessions.length} session{sessions.length === 1 ? "" : "s"}
        {activeCount > 0 && <span className="text-info"> · {activeCount} active</span>}
        {node.alsoUnder.length > 0 && ` · also under ${node.alsoUnder.map(seatName).join(", ")}`}
        {seat.rigName && ` · ${seat.rigName}`}
      </span>
      {sessions.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-border/70 pt-1.5">
          {sessions.slice(0, SESSION_PREVIEW).map((session) => (
            <li key={session.key} className="flex h-[18px] min-w-0 items-center gap-1.5 text-3xs">
              <span className={`size-1.5 shrink-0 rounded-full ${session.active ? "bg-info" : "bg-muted-foreground/35"}`} aria-hidden />
              <span className={`min-w-0 flex-1 truncate ${session.primary ? "font-semibold" : "text-muted-foreground"}`}>
                {session.title}
              </span>
              {session.spawnedFrom && session.spawnedFrom.seatId !== seat.id && (
                <span className="max-w-20 shrink-0 truncate text-info/80">↳ {seatName(session.spawnedFrom.seatId)}</span>
              )}
              <span className="max-w-20 shrink-0 truncate text-muted-foreground/80">{session.model ?? "—"}</span>
            </li>
          ))}
          {sessions.length > SESSION_PREVIEW && (
            <li className="text-3xs text-muted-foreground">+{sessions.length - SESSION_PREVIEW} more · select for details</li>
          )}
        </ul>
      )}
      {expandable && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={node.collapsed ? `Expand ${seat.name}` : `Collapse ${seat.name}`}
          className="absolute top-1/2 -right-3 flex h-6 min-w-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-popover px-1 text-3xs font-semibold text-muted-foreground shadow-xs hover:text-foreground"
          onClick={(event) => { event.stopPropagation(); onToggle(); }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {node.collapsed ? `+${node.hidden}` : <MinusIcon className="size-3" aria-hidden />}
        </button>
      )}
    </div>
  );
}
