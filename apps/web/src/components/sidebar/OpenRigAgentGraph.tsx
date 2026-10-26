import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  MinusIcon,
  PlusIcon,
  RotateCwIcon,
  ScanIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "../ui/button";
import { SEAT_STATUS_DOT, seatStatusTone, type SeatStatusTone } from "./openRigAgentPresentation";
import {
  CHILD_CARD_H,
  CHILD_CARD_W,
  edgePath,
  layoutAgentGraph,
  NODE_W,
  SESSION_PREVIEW,
  seatKind,
  type ChildCard,
  type ChildSessionInput,
  type GraphNode,
} from "./openRigAgentGraphLayout";
import type { AgentNetwork, NetworkSeat, TreeRow } from "./openRigNetwork";

/**
 * Top-down 2D drawing of the seat tree (parents above children, connectors from
 * bottom to top ports). Placement and edges live in openRigAgentGraphLayout.ts;
 * this file draws boxes, edges, status borders, the context menu, zoom and
 * keyboard navigation. Solid edges are RigSpec delegation, dashed are additional
 * RigSpec parents, dotted are managed sessions spawned from another seat.
 *
 * Interaction: double click / Enter opens the seat's exact T3 session (only when
 * `getSeatSessionId` resolves one; never guesses or falls back to the workspace);
 * the workspace is reached from the right-click menu. While a manager is selected,
 * `childSessions` for that seat are drawn as temporary cards; nothing is mutated.
 */

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 1.5;

/** The border carries the status: color, weight and a label that always says it in words. */
const TONE_FRAME: Record<SeatStatusTone, string> = {
  working: "border-info ring-4 ring-info/15",
  waiting: "border-warning ring-2 ring-warning/20",
  blocked: "border-destructive bg-destructive/[0.04] ring-2 ring-destructive/20",
  idle: "border-success/60",
  offline: "border-muted-foreground/40 opacity-70",
  unknown: "border-border",
};

const TONE_BADGE: Record<SeatStatusTone, string> = {
  working: "bg-info/12 text-info",
  waiting: "bg-warning/14 text-warning-foreground",
  blocked: "bg-destructive/12 text-destructive-foreground",
  idle: "bg-success/12 text-success-foreground",
  offline: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
};

const toneText = (tone: SeatStatusTone, raw: string) =>
  tone === "working"
    ? "Working"
    : tone === "waiting"
      ? "Waiting"
      : tone === "blocked"
        ? /^(error|failed)$/iu.test(raw.trim())
          ? "Error"
          : "Blocked"
        : tone === "idle"
          ? "Idle"
          : tone === "offline"
            ? "Offline"
            : "Unknown";

const statusTitle = (tone: SeatStatusTone, raw: string | null | undefined) =>
  raw ? `${toneText(tone, raw)} — OpenRig reports “${raw}”` : "Unknown — not in the agent list";

type MenuTarget = { kind: "seat"; id: string } | { kind: "session"; id: string };
type MenuItem =
  | { key: string; label: string; icon: LucideIcon; run: () => void }
  | { key: string; separator: true };

/** Callbacks the memoized nodes share; identity is stable so only changed nodes repaint. */
interface NodeActions {
  focus: (id: string) => void;
  select: (id: string) => void;
  toggle: (id: string) => void;
  open: (id: string) => void;
  menu: (target: MenuTarget, event: MouseEvent<HTMLElement>) => void;
  openChild: (sessionId: string) => void;
}

export function OpenRigAgentGraph(props: {
  network: AgentNetwork;
  rows: readonly TreeRow[];
  collapsed: ReadonlySet<string>;
  selectedId: string | null;
  emptyText: string;
  onToggle: (id: string, open?: boolean) => void;
  onSelect: (id: string) => void;
  /** Opens the seat's workspace. Reached only from the context menu. */
  onOpenAgent: (seatId: string) => void;
  /** Verified child sessions; drawn only under the selected manager whose seat id is `parentId`. */
  childSessions?: readonly ChildSessionInput[];
  onOpenSession?: (sessionId: string) => void;
  onReloadSession?: (sessionId: string) => void;
  /** Exact T3 browser session of a seat, or null. Without it no seat can open a session. */
  getSeatSessionId?: (seatId: string) => string | null;
  onReloadSeatSession?: (seatId: string) => void;
  /** Result of a reload (success or refusal) reported by the parent; shown as a non-blocking status above the controls. */
  actionNotice?: string | null;
}) {
  const { network, rows, collapsed, selectedId, emptyText, childSessions } = props;
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const menuOrigin = useRef<HTMLElement | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  // Handlers read the latest props through this ref so `actions` never changes identity.
  const latest = useRef(props);
  latest.current = props;

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

  const hasChildSessions = (childSessions?.length ?? 0) > 0;
  const layout = useMemo(
    () =>
      layoutAgentGraph(rows, collapsed, 0, {
        selectedManagerId: hasChildSessions ? selectedId : null,
        ...(childSessions ? { childSessions } : {}),
      }),
    [rows, collapsed, hasChildSessions, selectedId, childSessions],
  );
  // Fit shrinks wide trees to the viewport width; it never enlarges small ones.
  const fitScale =
    viewportWidth > 0 ? Math.min(1, Math.max(MIN_ZOOM, viewportWidth / layout.width)) : 1;
  const scale = zoom === "fit" ? fitScale : zoom;
  const stepZoom = (delta: number) =>
    setZoom(Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale + delta)) * 10) / 10);

  const activeFocus = focusId && layout.nodes.has(focusId) ? focusId : (layout.order[0] ?? null);
  const focusNode = useCallback((id: string | undefined | null) => {
    if (!id) return;
    setFocusId(id);
    viewportRef.current?.querySelector<HTMLElement>(`[data-seat-id="${CSS.escape(id)}"]`)?.focus();
  }, []);
  useEffect(() => {
    if (selectedId) setFocusId(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), 3200);
    return () => window.clearTimeout(timer);
  }, [hint]);

  const actions = useMemo<NodeActions>(
    () => ({
      focus: setFocusId,
      select: (id) => latest.current.onSelect(id),
      toggle: (id) => latest.current.onToggle(id),
      open: (id) => {
        const { getSeatSessionId, onOpenSession } = latest.current;
        const sessionId = getSeatSessionId?.(id) ?? null;
        if (sessionId && onOpenSession) onOpenSession(sessionId);
        else setHint("No T3 session is linked to this seat. Right-click for Open workspace.");
      },
      openChild: (sessionId) => latest.current.onOpenSession?.(sessionId),
      menu: (target, event) => {
        event.preventDefault();
        event.stopPropagation();
        menuOrigin.current = event.currentTarget;
        let { clientX: x, clientY: y } = event;
        if (x === 0 && y === 0) {
          // Keyboard-invoked (Menu key / Shift+F10): anchor to the element.
          const rect = event.currentTarget.getBoundingClientRect();
          x = rect.left + 16;
          y = rect.top + 16;
        }
        setMenu({ x, y, target });
      },
    }),
    [],
  );

  const menuItems = (target: MenuTarget): MenuItem[] => {
    const { getSeatSessionId, onOpenSession, onReloadSession, onReloadSeatSession } = props;
    const items: MenuItem[] = [];
    if (target.kind === "session") {
      if (onOpenSession)
        items.push({
          key: "open",
          label: "Open session",
          icon: ExternalLinkIcon,
          run: () => onOpenSession(target.id),
        });
      if (onReloadSession)
        items.push({
          key: "reload",
          label: "Reload",
          icon: RotateCwIcon,
          run: () => onReloadSession(target.id),
        });
      const parent = childSessions?.find((session) => session.id === target.id)?.parentId;
      if (parent) {
        if (items.length > 0) items.push({ key: "sep", separator: true });
        items.push({
          key: "select",
          label: "Select manager",
          icon: CheckIcon,
          run: () => {
            props.onSelect(parent);
            focusNode(parent);
          },
        });
      }
      return items;
    }
    const node = layout.nodes.get(target.id);
    const sessionId = getSeatSessionId?.(target.id) ?? null;
    if (sessionId && onOpenSession)
      items.push({
        key: "open",
        label: "Open session",
        icon: ExternalLinkIcon,
        run: () => onOpenSession(sessionId),
      });
    items.push({
      key: "workspace",
      label: "Open workspace",
      icon: FolderOpenIcon,
      run: () => props.onOpenAgent(target.id),
    });
    if (sessionId && onReloadSeatSession)
      items.push({
        key: "reload",
        label: "Reload",
        icon: RotateCwIcon,
        run: () => onReloadSeatSession(target.id),
      });
    items.push({ key: "sep", separator: true });
    items.push({
      key: "select",
      label: "Select",
      icon: CheckIcon,
      run: () => props.onSelect(target.id),
    });
    if (node && node.childIds.length > 0)
      items.push({
        key: "toggle",
        label: node.collapsed ? `Expand ${node.hidden} below` : "Collapse children",
        icon: node.collapsed ? ChevronsUpDownIcon : ChevronsDownUpIcon,
        run: () => props.onToggle(target.id),
      });
    return items;
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-seat-id]")?.dataset.seatId;
    const node = id ? layout.nodes.get(id) : undefined;
    if (!node || !id) return;
    const index = layout.order.indexOf(id);
    const expandable = node.childIds.length > 0;
    switch (event.key) {
      case "ArrowDown":
        if (event.shiftKey || (expandable && node.collapsed)) {
          if (expandable && node.collapsed) props.onToggle(id, true);
        } else focusNode(node.childIds[0]);
        break;
      case "ArrowUp":
        if (event.shiftKey) {
          if (expandable && !node.collapsed) props.onToggle(id, false);
        } else focusNode(node.parentId);
        break;
      case "ArrowRight":
        focusNode(layout.order[Math.min(layout.order.length - 1, index + 1)]);
        break;
      case "ArrowLeft":
        focusNode(layout.order[Math.max(0, index - 1)]);
        break;
      case "Home":
        focusNode(layout.order[0]);
        break;
      case "End":
        focusNode(layout.order.at(-1));
        break;
      case "Enter":
        actions.open(id);
        break;
      case " ":
        props.onSelect(id);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenu(null);
    if (restoreFocus) menuOrigin.current?.focus();
  }, []);

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
              className="relative origin-top-left"
              style={{
                width: layout.width,
                height: layout.height,
                transform: scale === 1 ? undefined : `scale(${scale})`,
              }}
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
                {layout.childCards.map((card) => (
                  <path
                    key={card.session.id}
                    d={card.path}
                    className="text-info/60"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.25}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    markerEnd="url(#openrig-graph-arrow-info)"
                  />
                ))}
              </svg>
              {layout.unplacedTop !== null && (
                <div
                  className="absolute flex items-center gap-1.5 text-3xs font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase"
                  style={{ left: layout.unplacedLeft, top: layout.unplacedTop }}
                  title={
                    network.topologyAvailable
                      ? "Outside RigSpec topology · no parent known"
                      : "Seat hierarchy unavailable · no links guessed"
                  }
                >
                  <CircleDashedIcon className="size-3" aria-hidden />
                  {network.topologyAvailable ? "Unplaced · no parent" : "Hierarchy unavailable"}
                </div>
              )}
              {layout.childGroup && (
                <div
                  role="group"
                  aria-label={`${layout.childCards.length} child sessions of ${network.seats.get(layout.childGroup.managerId)?.name ?? layout.childGroup.managerId}`}
                  className="absolute rounded-xl border border-dashed border-info/40 bg-info/[0.04]"
                  style={{
                    left: layout.childGroup.x,
                    top: layout.childGroup.y,
                    width: layout.childGroup.width,
                    height: layout.childGroup.height,
                  }}
                >
                  <span className="absolute top-1 left-4 flex items-center gap-1 text-3xs font-semibold tracking-wide text-info uppercase">
                    <UsersRoundIcon className="size-3" aria-hidden />
                    Child sessions · {layout.childCards.length}
                  </span>
                  {layout.childCards.map((card) => (
                    <ChildSessionCard
                      key={card.session.id}
                      card={card}
                      originX={layout.childGroup!.x}
                      originY={layout.childGroup!.y}
                      actions={actions}
                      canOpen={Boolean(props.onOpenSession)}
                    />
                  ))}
                </div>
              )}
              <div
                role="tree"
                aria-label="OpenRig seats and their delegation"
                className="pointer-events-none absolute inset-0"
                onKeyDown={keyDown}
              >
                {layout.order.map((id) => (
                  <SeatNode
                    key={id}
                    node={layout.nodes.get(id)!}
                    focused={id === activeFocus}
                    selected={id === selectedId}
                    seats={network.seats}
                    actions={actions}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      {hint && (
        <p
          role="status"
          className="pointer-events-none absolute inset-x-2 top-2 mx-auto w-fit max-w-full rounded-lg border border-border bg-popover/95 px-2.5 py-1 text-3xs text-muted-foreground shadow-sm"
        >
          {hint}
        </p>
      )}
      {/* Always-mounted live region so screen readers announce text changes reliably. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none absolute inset-x-2 bottom-11 flex justify-end"
      >
        {props.actionNotice && (
          <p className="max-w-full rounded-lg border border-border bg-popover/95 px-2.5 py-1 text-xs text-popover-foreground shadow-sm">
            {props.actionNotice}
          </p>
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
      {menu && (
        <GraphContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.target)}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

/**
 * Compact native-style context menu, portalled to <body> so graph zoom transforms
 * and clipping cannot displace it. Escape / outside click / scroll closes it;
 * arrow keys, Home/End move between items.
 */
function GraphContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: readonly MenuItem[];
  onClose: (restoreFocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
    element.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [x, y]);

  useEffect(() => {
    const away = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose(false);
    };
    const close = () => onClose(false);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("scroll", away, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => entries[(next + entries.length) % entries.length]?.focus();
    switch (event.key) {
      case "Escape":
      case "Tab":
        onClose(true);
        break;
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index < 0 ? -1 : index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(entries.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Seat actions"
      className="fixed z-[100] min-w-40 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg/10 outline-none"
      style={position}
      onKeyDown={keyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) =>
        "separator" in item ? (
          <div key={item.key} role="separator" className="mx-1 my-1 h-px bg-border" />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => {
              onClose(true);
              item.run();
            }}
          >
            <item.icon className="size-3.5 text-muted-foreground" aria-hidden />
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
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

/** A temporary verified child session of the selected manager; double click / Enter opens it. */
const ChildSessionCard = memo(function ChildSessionCard({
  card,
  originX,
  originY,
  actions,
  canOpen,
}: {
  card: ChildCard;
  originX: number;
  originY: number;
  actions: NodeActions;
  canOpen: boolean;
}) {
  const { session } = card;
  const tone = session.working ? "working" : seatStatusTone(session.status);
  const text = toneText(tone, session.status);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Child session ${session.title}, ${text.toLowerCase()}`}
      title={`${session.title}\n${statusTitle(tone, session.status)}`}
      className={`absolute flex cursor-pointer flex-col justify-center gap-0.5 rounded-lg border-2 bg-card px-2.5 text-left shadow-xs outline-none hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring ${TONE_FRAME[tone]}`}
      style={{
        left: card.x - originX,
        top: card.y - originY,
        width: CHILD_CARD_W,
        height: CHILD_CARD_H,
      }}
      onDoubleClick={() => canOpen && actions.openChild(session.id)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        if (canOpen) actions.openChild(session.id);
      }}
      onContextMenu={(event) => actions.menu({ kind: "session", id: session.id }, event)}
    >
      <span className="truncate text-xs font-semibold">{session.title}</span>
      <span className="flex items-center gap-1.5 text-3xs">
        <span className={`size-1.5 shrink-0 rounded-full ${SEAT_STATUS_DOT[tone]}`} aria-hidden />
        <span className={`rounded-full px-1.5 font-semibold ${TONE_BADGE[tone]}`}>{text}</span>
        <span className="min-w-0 truncate text-muted-foreground">{session.status}</span>
      </span>
    </div>
  );
});

const SeatNode = memo(function SeatNode({
  node,
  focused,
  selected,
  seats,
  actions,
}: {
  node: GraphNode;
  focused: boolean;
  selected: boolean;
  seats: ReadonlyMap<string, NetworkSeat>;
  actions: NodeActions;
}) {
  const { seat, sessions } = node;
  const seatName = (id: string) => seats.get(id)?.name ?? id;
  // Status comes from OpenRig's own status string only, never from session activity.
  const tone = seatStatusTone(seat.status ?? "");
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
      title={statusTitle(tone, seat.status)}
      data-seat-id={seat.id}
      tabIndex={focused ? 0 : -1}
      onFocus={() => actions.focus(seat.id)}
      onClick={() => actions.select(seat.id)}
      onDoubleClick={() => actions.open(seat.id)}
      onContextMenu={(event) => actions.menu({ kind: "seat", id: seat.id }, event)}
      className={`pointer-events-auto absolute cursor-pointer rounded-xl border-2 bg-card text-left shadow-xs transition-[box-shadow,border-color] hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring ${TONE_FRAME[tone]} ${seat.inTopology ? "" : "border-dashed"} ${selected ? "outline-2 outline-offset-2 outline-primary" : "outline-none"}`}
      style={{ left: node.x, top: node.y, width: NODE_W, height: node.height }}
    >
      {/* Fixed-size box: the clipped inner layer keeps content from spilling onto neighbours. */}
      <div className="flex size-full flex-col overflow-hidden rounded-[inherit] px-3 pt-1.5">
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
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-3xs font-semibold ${TONE_BADGE[tone]}`}
            title={statusTitle(tone, seat.status)}
          >
            <span className={`size-1.5 rounded-full ${SEAT_STATUS_DOT[tone]}`} aria-hidden />
            {toneText(tone, seat.status ?? "")}
          </span>
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
          className="absolute -bottom-3 left-1/2 flex h-6 min-w-6 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-popover px-1 text-3xs font-semibold text-muted-foreground shadow-xs hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            actions.toggle(seat.id);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {node.collapsed ? `+${node.hidden}` : <MinusIcon className="size-3" aria-hidden />}
        </button>
      )}
    </div>
  );
});
