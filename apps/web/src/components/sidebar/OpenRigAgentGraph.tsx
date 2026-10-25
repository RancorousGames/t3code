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
import {
  edgePath,
  layoutAgentGraph,
  NODE_W,
  PAD,
  SESSION_PREVIEW,
  seatActive,
  seatKind,
  type GraphNode,
} from "./openRigAgentGraphLayout";
import type { AgentNetwork, TreeRow } from "./openRigNetwork";

/**
 * Left-to-right 2D drawing of the seat tree. Placement and edges live in
 * openRigAgentGraphLayout.ts; this file draws boxes, edges, zoom and keyboard
 * navigation. Solid edges are RigSpec delegation, dashed are additional RigSpec
 * parents, dotted are managed sessions spawned from another seat.
 */

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.5;

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
    const observer = new ResizeObserver(([entry]) =>
      setViewportWidth(Math.round(entry?.contentRect.width ?? 0)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => layoutAgentGraph(rows, collapsed, viewportWidth || 900),
    [rows, collapsed, viewportWidth],
  );
  // Fit shrinks wide trees to the viewport width; it never enlarges small ones.
  const fitScale =
    viewportWidth > 0 ? Math.min(1, Math.max(MIN_ZOOM, viewportWidth / layout.width)) : 1;
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
      case "ArrowDown":
        focusNode(layout.order[Math.min(layout.order.length - 1, index + 1)]);
        break;
      case "ArrowUp":
        focusNode(layout.order[Math.max(0, index - 1)]);
        break;
      case "Home":
        focusNode(layout.order[0]);
        break;
      case "End":
        focusNode(layout.order.at(-1));
        break;
      case "ArrowRight":
        if (expandable && node.collapsed) onToggle(activeFocus, true);
        else focusNode(node.childIds[0]);
        break;
      case "ArrowLeft":
        if (expandable && !node.collapsed) onToggle(activeFocus, false);
        else focusNode(node.parentId);
        break;
      case "Enter":
        onOpenAgent(activeFocus);
        break;
      case " ":
        onSelect(activeFocus);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={viewportRef}
        className="absolute inset-0 overflow-auto overscroll-contain"
        style={{
          backgroundImage:
            "radial-gradient(color-mix(in srgb, var(--muted-foreground) 20%, transparent) 1px, transparent 1px)",
          backgroundSize: `${20 * scale}px ${20 * scale}px`,
        }}
      >
        {layout.order.length === 0 ? (
          <p className="px-3 py-10 text-center text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          <div
            className="pb-12"
            style={{ width: layout.width * scale, height: layout.height * scale }}
          >
            <div
              role="tree"
              aria-label="OpenRig seats and their delegation"
              className="relative origin-top-left"
              style={{
                width: layout.width,
                height: layout.height,
                transform: scale === 1 ? undefined : `scale(${scale})`,
              }}
              onKeyDown={keyDown}
            >
              <svg
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-visible"
                width={layout.width}
                height={layout.height}
              >
                <defs>
                  {(["muted", "info"] as const).map((name) => (
                    <marker
                      key={name}
                      id={`openrig-graph-arrow-${name}`}
                      viewBox="0 0 8 8"
                      refX="7"
                      refY="4"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto"
                      className={name === "info" ? "text-info/75" : "text-muted-foreground/55"}
                    >
                      <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
                    </marker>
                  ))}
                </defs>
                {layout.edges.map((edge) => {
                  const info = edge.kind === "spawned" || edge.active;
                  const tone = info
                    ? "text-info/75"
                    : edge.kind === "also-delegates"
                      ? "text-muted-foreground/40"
                      : "text-muted-foreground/55";
                  return (
                    <path
                      key={edge.key}
                      d={edgePath(
                        layout.nodes.get(edge.from)!,
                        layout.nodes.get(edge.to)!,
                        edge.kind,
                      )}
                      className={tone}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={edge.kind === "delegates" ? 1.6 : 1.25}
                      strokeDasharray={
                        edge.kind === "also-delegates"
                          ? "6 5"
                          : edge.kind === "spawned"
                            ? "1.5 4"
                            : undefined
                      }
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
                  {network.topologyAvailable
                    ? "Outside RigSpec topology · no parent known"
                    : "Seat hierarchy unavailable · no links guessed"}
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
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Zoom out"
            onClick={() => stepZoom(-0.1)}
          >
            <MinusIcon aria-hidden />
          </Button>
          <button
            type="button"
            className="min-w-11 px-1 text-center text-3xs font-medium text-muted-foreground tabular-nums hover:text-foreground"
            aria-label={
              zoom === "fit"
                ? `Fitted to width at ${Math.round(scale * 100)}%`
                : "Fit graph to width"
            }
            title="Fit to width"
            onClick={() => setZoom("fit")}
          >
            {zoom === "fit" ? (
              <span className="inline-flex items-center gap-1">
                <ScanIcon className="size-3" aria-hidden />
                {Math.round(scale * 100)}%
              </span>
            ) : (
              `${Math.round(scale * 100)}%`
            )}
          </button>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Zoom in"
            onClick={() => stepZoom(0.1)}
          >
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
      <path
        d="M1,3 H21"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={dash}
        strokeLinecap="round"
      />
    </svg>
  );
  return (
    <div className="pointer-events-auto hidden flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-popover/95 px-2.5 py-1.5 text-3xs text-muted-foreground shadow-sm sm:flex">
      <span className="inline-flex items-center gap-1">
        {line(undefined, "text-muted-foreground/70")}Delegates
      </span>
      <span className="inline-flex items-center gap-1">
        {line("5 4", "text-muted-foreground/60")}Also delegated by
      </span>
      <span className="inline-flex items-center gap-1">
        {line("1.5 3.5", "text-info/80")}Spawned session
      </span>
      <span className="inline-flex items-center gap-1">
        <UsersRoundIcon className="size-3" aria-hidden />
        Manager
      </span>
      <span className="inline-flex items-center gap-1">
        <BotIcon className="size-3" aria-hidden />
        Worker
      </span>
      <span className="inline-flex items-center gap-1">
        <CircleDashedIcon className="size-3" aria-hidden />
        Unplaced
      </span>
    </div>
  );
}

function SeatNode({
  node,
  focused,
  selected,
  seatName,
  onFocus,
  onSelect,
  onToggle,
  onOpenAgent,
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
  const kind = seatKind(seat);
  const KindIcon =
    kind === "Manager" ? UsersRoundIcon : kind === "Worker" ? BotIcon : CircleDashedIcon;
  const expandable = node.childIds.length > 0;
  const activeCount = sessions.filter((session) => session.active).length;
  const manager = kind === "Manager";
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
      className={`absolute cursor-pointer rounded-xl border bg-card text-left shadow-xs transition-[box-shadow,border-color] hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring ${TONE_FRAME[tone]} ${seat.inTopology ? "" : "border-dashed"} ${selected ? "outline-2 outline-offset-2 outline-primary" : "outline-none"}`}
      style={{ left: node.x, top: node.y, width: NODE_W, height: node.height }}
    >
      {/* Fixed-size box: the clipped inner layer keeps content from spilling onto neighbours. */}
      <div className="flex size-full flex-col overflow-hidden rounded-[inherit] px-3 pt-2">
        <span className="flex h-6 shrink-0 items-center gap-2">
          <span
            className={`flex size-6 shrink-0 items-center justify-center rounded-md ${manager ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
            aria-hidden
          >
            <KindIcon className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={seat.name}>
            {seat.name}
          </span>
          {seat.ledger === "failed" && (
            <span title={`Ledger unreadable: ${seat.ledgerError ?? ""}`}>
              <AlertTriangleIcon className="size-3.5 text-warning" aria-label="Ledger unreadable" />
            </span>
          )}
          {toneLabel ? (
            <span
              className={`shrink-0 rounded-full px-1.5 py-px text-3xs font-semibold ${toneLabel.className}`}
            >
              {toneLabel.text}
            </span>
          ) : (
            <span className={`size-2 shrink-0 rounded-full ${SEAT_STATUS_DOT[tone]}`} aria-hidden />
          )}
        </span>
        <span
          className="mt-0.5 flex h-4 min-w-0 shrink-0 items-center gap-1 pl-8 text-3xs text-muted-foreground"
          title={[
            seat.role,
            seat.rigName,
            node.alsoUnder.length > 0
              ? `also under ${node.alsoUnder.map(seatName).join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <span
            className={`shrink-0 font-medium ${manager ? "text-primary" : "text-foreground/70"}`}
          >
            {kind}
          </span>
          <span className="truncate">
            · {sessions.length} session{sessions.length === 1 ? "" : "s"}
            {activeCount > 0 && <span className="text-info"> · {activeCount} active</span>}
            {node.alsoUnder.length > 0 && " · +parent"}
          </span>
        </span>
        {sessions.length > 0 && (
          <ul className="mt-2 shrink-0 space-y-0.5 border-t border-border/70 pt-1.5">
            {sessions.slice(0, SESSION_PREVIEW).map((session) => (
              <li key={session.key} className="flex h-[18px] min-w-0 items-center gap-1.5 text-3xs">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${session.active ? "bg-info" : "bg-muted-foreground/35"}`}
                  aria-hidden
                />
                <span
                  className={`min-w-0 flex-1 truncate ${session.primary ? "font-semibold" : "text-muted-foreground"}`}
                  title={session.title}
                >
                  {session.title}
                </span>
                {session.spawnedFrom && session.spawnedFrom.seatId !== seat.id && (
                  <span className="max-w-16 shrink-0 truncate text-info/80">
                    ↳ {seatName(session.spawnedFrom.seatId)}
                  </span>
                )}
                <span className="max-w-16 shrink-0 truncate text-muted-foreground/80">
                  {session.model ?? "—"}
                </span>
              </li>
            ))}
            {sessions.length > SESSION_PREVIEW && (
              <li className="h-3.5 text-3xs text-muted-foreground">
                +{sessions.length - SESSION_PREVIEW} more · select for details
              </li>
            )}
          </ul>
        )}
      </div>
      {expandable && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={node.collapsed ? `Expand ${seat.name}` : `Collapse ${seat.name}`}
          className="absolute top-1/2 -right-3 flex h-6 min-w-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-popover px-1 text-3xs font-semibold text-muted-foreground shadow-xs hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {node.collapsed ? `+${node.hidden}` : <MinusIcon className="size-3" aria-hidden />}
        </button>
      )}
    </div>
  );
}
