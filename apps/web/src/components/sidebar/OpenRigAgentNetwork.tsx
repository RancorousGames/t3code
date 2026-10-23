import type { DesktopOpenRigAgent, DesktopOpenRigSeatTopology } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, NetworkIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useThreadShells } from "../../state/entities";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { OpenRigFloatingWindow, type FloatingSize } from "./OpenRigFloatingWindow";
import { OpenRigCanonicalSpawnApprovals } from "./OpenRigSpawnApproval";
import { SEAT_STATUS_DOT, explanation, formatTimestamp, seatStatusTone } from "./openRigAgentPresentation";
import {
  isCostlyModel,
  parseCostlyPatterns,
  readCostlyPatterns,
  writeCostlyPatterns,
} from "./openRigCostPolicy";
import {
  buildAgentNetwork,
  flattenAgentTree,
  sessionMatches,
  type LedgerResult,
  type NetworkFilter,
  type NetworkSession,
  type TreeRow,
} from "./openRigNetwork";

const GEOMETRY_KEY = "t3code:openrig-agent-network-geometry:v1";
const MIN_SIZE: FloatingSize = { width: 380, height: 420 };
const LEDGER_CONCURRENCY = 4;
const UNATTRIBUTED_PAGE = 60;

function defaultNetworkGeometry(viewport: FloatingSize) {
  const left = viewport.width >= 1200 ? 340 : 16;
  return { left, top: 48, width: Math.min(1180, viewport.width - left - 24), height: Math.min(820, viewport.height - 64) };
}

/** Reads every seat ledger once per open/refresh, a few at a time. Never polls per seat. */
function useSeatLedgers(seatIds: readonly string[]) {
  const [ledgers, setLedgers] = useState<ReadonlyMap<string, LedgerResult>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const run = useRef(0);
  const idsKey = seatIds.join("\u0000");
  const load = useCallback(async () => {
    const version = ++run.current;
    const ids = idsKey ? idsKey.split("\u0000") : [];
    const method = window.desktopBridge?.listOpenRigManagedSessions;
    setLoading(true);
    const next = new Map<string, LedgerResult>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++]!;
        try {
          if (!method) throw new Error("Managed session IPC is not installed. Update T3.");
          next.set(id, { ok: true, ledger: await method(id) });
        } catch (error) {
          next.set(id, { ok: false, error: explanation(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LEDGER_CONCURRENCY, ids.length) }, worker));
    if (version !== run.current) return;
    setLedgers(next);
    setLoadedAt(new Date().toISOString());
    setLoading(false);
  }, [idsKey]);
  useEffect(() => {
    void load();
    return () => { run.current++; };
  }, [load]);
  return { ledgers, loading, loadedAt, reload: load };
}

export function OpenRigAgentNetwork({
  agents,
  topology,
  topologyError,
  onRefreshAgents,
  onOpenAgent,
  onClose,
}: {
  agents: readonly DesktopOpenRigAgent[];
  topology: DesktopOpenRigSeatTopology | null;
  topologyError: string | null;
  onRefreshAgents: () => Promise<void>;
  onOpenAgent: (seatId: string) => void;
  onClose: () => void;
}) {
  const seatIds = useMemo(
    () => [...new Set([...(topology?.seats.map((seat) => seat.id) ?? []), ...agents.map((agent) => agent.id)])].sort(),
    [agents, topology],
  );
  const { ledgers, loading, loadedAt, reload } = useSeatLedgers(seatIds);
  const threads = useThreadShells(true);
  const [costlyPatterns, setCostlyPatterns] = useState(readCostlyPatterns);
  const [costlyDraft, setCostlyDraft] = useState(() => readCostlyPatterns().join(", "));
  const [query, setQuery] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [costlyOnly, setCostlyOnly] = useState(false);
  const [rigId, setRigId] = useState("");
  const [model, setModel] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showUnattributed, setShowUnattributed] = useState(false);
  const [unattributedLimit, setUnattributedLimit] = useState(UNATTRIBUTED_PAGE);
  const [focusIndex, setFocusIndex] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);

  const network = useMemo(
    () => buildAgentNetwork({ agents, topology, ledgers, threads, costlyPatterns }),
    [agents, topology, ledgers, threads, costlyPatterns],
  );
  const filter: NetworkFilter = { query, activeOnly, costlyOnly, rigId, model, costlyPatterns };
  const expanded = useMemo(
    () => new Set([...network.seats.keys()].filter((id) => !collapsed.has(id))),
    [network, collapsed],
  );
  const rows = flattenAgentTree(network, expanded, filter);
  const unattributed = network.unattributed.filter((session) => sessionMatches(session, filter));
  const rigs = useMemo(
    () => [...new Map(topology?.seats.map((seat) => [seat.rigId, seat.rigName || seat.rigId]) ?? []).entries()],
    [topology],
  );

  const toggle = (id: string, open?: boolean) =>
    setCollapsed((prior) => {
      const next = new Set(prior);
      if (open ?? next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const treeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[focusIndex];
    let next = focusIndex;
    if (event.key === "ArrowDown") next = Math.min(rows.length - 1, focusIndex + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, focusIndex - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (row?.kind === "seat" && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      toggle(row.seat.id, event.key === "ArrowRight");
      return;
    } else if (event.key === "Enter" && row) {
      event.preventDefault();
      const seatId = row.kind === "seat" ? row.seat.id : row.session.seatId;
      if (seatId) onOpenAgent(seatId);
      return;
    } else return;
    event.preventDefault();
    setFocusIndex(next);
    treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[next]?.focus();
  };

  return (
    <OpenRigFloatingWindow
      id="openrig-agent-network"
      label="OpenRig agent network"
      storageKey={GEOMETRY_KEY}
      defaultGeometry={defaultNetworkGeometry}
      minSize={MIN_SIZE}
      compactBelow={860}
      onEscape={onClose}
      header={() => (
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-info/10 text-info">
            <NetworkIcon className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Agent network</h2>
            <p className="text-2xs text-muted-foreground">
              {network.seats.size} seats · {[...network.seats.values()].reduce((sum, seat) => sum + seat.sessions.length, 0)} owned sessions ·{" "}
              {network.unattributed.length} unattributed T3 threads
              {loadedAt && ` · Ledgers read ${formatTimestamp(loadedAt)}`}
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label="Refresh agent network"
            disabled={loading}
            onClick={() => { void onRefreshAgents(); void reload(); }}
          >
            <RefreshCwIcon aria-hidden />
          </Button>
          <Button size="icon-sm" variant="ghost-muted" aria-label="Close agent network" onClick={onClose}>
            <XIcon aria-hidden />
          </Button>
        </header>
      )}
    >
      {({ compact }) => (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
            <input
              type="search"
              aria-label="Search agents and sessions"
              placeholder="Search seats, sessions, models, projects"
              className="h-8 min-w-48 flex-1 rounded-md border border-border bg-background px-2 text-xs"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); }
              }}
            />
            <div role="group" aria-label="Session scope" className="flex rounded-md border border-border">
              {([[false, "History"], [true, "Active only"]] as const).map(([value, text]) => (
                <button
                  key={text}
                  type="button"
                  aria-pressed={activeOnly === value}
                  className={`px-2 py-1 text-2xs font-medium ${activeOnly === value ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
                  onClick={() => setActiveOnly(value)}
                >
                  {text}
                </button>
              ))}
            </div>
            <select aria-label="Filter by rig" className="h-8 rounded-md border border-border bg-background px-1 text-xs" value={rigId}
              onChange={(event) => setRigId(event.currentTarget.value)}>
              <option value="">All rigs</option>
              {rigs.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select aria-label="Filter by model" className="h-8 max-w-48 rounded-md border border-border bg-background px-1 text-xs" value={model}
              onChange={(event) => setModel(event.currentTarget.value)}>
              <option value="">All models</option>
              {network.modelUsage.map((entry) => <option key={entry.model} value={entry.model}>{entry.model} ({entry.total})</option>)}
            </select>
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" aria-label="Show only costly models" checked={costlyOnly}
                onChange={(event) => setCostlyOnly(event.currentTarget.checked)} />
              Costly only
            </label>
          </div>
          {(topologyError || !network.topologyAvailable || network.unreadLedgers > 0) && (
            <div role="status" className="mx-4 mt-2 shrink-0 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-2xs leading-relaxed">
              {!network.topologyAvailable && (
                <p>Seat hierarchy unavailable{topologyError ? `: ${topologyError}` : ""}. Seats are listed flat; no parent links are guessed.</p>
              )}
              {network.unreadLedgers > 0 && (
                <p>
                  {loading ? "Reading" : "Could not read"} {network.unreadLedgers} seat ledger(s). Threads those seats own may appear as
                  unattributed until they load.
                </p>
              )}
            </div>
          )}
          <div className={`grid min-h-0 flex-1 ${compact ? "grid-cols-1 overflow-y-auto" : "grid-cols-[minmax(0,1fr)_minmax(260px,320px)]"}`}>
            <div className={`min-h-0 ${compact ? "" : "overflow-y-auto overscroll-contain"}`}>
              <div
                ref={treeRef}
                role="tree"
                aria-label="OpenRig seats and their sessions"
                className="p-2"
                onKeyDown={treeKeyDown}
              >
                {rows.length === 0 && (
                  <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {network.seats.size === 0 ? "No OpenRig seats reported." : "No seats or sessions match these filters."}
                  </p>
                )}
                {rows.map((row, index) => (
                  <TreeItem
                    key={row.key}
                    row={row}
                    index={index}
                    focused={index === Math.min(focusIndex, rows.length - 1)}
                    seatName={(id) => network.seats.get(id)?.name ?? id}
                    costlyPatterns={costlyPatterns}
                    onFocus={() => setFocusIndex(index)}
                    onToggle={(id) => toggle(id)}
                    onOpenAgent={onOpenAgent}
                  />
                ))}
              </div>
              <section aria-label="Unattributed T3 threads" className="m-2 rounded-xl border border-dashed border-border">
                <button
                  type="button"
                  aria-expanded={showUnattributed}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium"
                  onClick={() => setShowUnattributed((value) => !value)}
                >
                  {showUnattributed ? <ChevronDownIcon className="size-3.5" aria-hidden /> : <ChevronRightIcon className="size-3.5" aria-hidden />}
                  Unattributed T3 threads ({unattributed.length})
                  <span className="font-normal text-muted-foreground">· not owned by any loaded OpenRig seat ledger</span>
                </button>
                {showUnattributed && (
                  <ul className="space-y-0.5 border-t border-dashed border-border p-2">
                    {unattributed.slice(0, unattributedLimit).map((session) => (
                      <SessionLine key={session.key} session={session} seatName={(id) => network.seats.get(id)?.name ?? id}
                        costlyPatterns={costlyPatterns} onOpenAgent={onOpenAgent} />
                    ))}
                    {unattributed.length > unattributedLimit && (
                      <li>
                        <Button size="xs" variant="ghost-muted" onClick={() => setUnattributedLimit((limit) => limit + UNATTRIBUTED_PAGE)}>
                          Show {Math.min(UNATTRIBUTED_PAGE, unattributed.length - unattributedLimit)} more
                        </Button>
                      </li>
                    )}
                  </ul>
                )}
              </section>
            </div>
            <aside className={`min-h-0 space-y-3 overflow-y-auto p-3 text-xs ${compact ? "border-t border-border" : "border-l border-border bg-muted/10"}`}>
              <section aria-label="Spawn approvals">
                <h3 className="mb-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">Spawn approvals</h3>
                <OpenRigCanonicalSpawnApprovals seatId={null}
                  seatName={(id) => network.seats.get(id)?.name ?? id} />
              </section>
              <section aria-label="Sessions by model">
                <h3 className="mb-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">Sessions by model</h3>
                <p className="mb-1.5 text-3xs text-muted-foreground">
                  Counts of known sessions and threads, not tokens or spend. Neither OpenRig nor T3 reports measured cost here.
                </p>
                <table className="w-full text-2xs">
                  <thead className="text-muted-foreground">
                    <tr><th className="text-left font-medium">Model</th><th className="text-right font-medium">Active</th><th className="text-right font-medium">Owned</th><th className="text-right font-medium">Unattr.</th></tr>
                  </thead>
                  <tbody>
                    {network.modelUsage.map((entry) => (
                      <tr key={entry.model} className={entry.costly ? "text-warning-foreground" : undefined}>
                        <td className="max-w-0 truncate py-0.5" aria-label={`Model ${entry.model}`}>
                          {entry.costly && <span className="mr-1 font-semibold text-warning">●</span>}{entry.model}
                        </td>
                        <td className="text-right">{entry.active}</td>
                        <td className="text-right">{entry.managed}</td>
                        <td className="text-right">{entry.unattributed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section aria-label="Costly model flags" className="space-y-1.5 rounded-xl border border-border p-2.5">
                <h3 className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">Costly model flags (this device)</h3>
                <p className="text-3xs text-muted-foreground">
                  Model names containing these are highlighted and need a confirmation before T3 launches them. Agents and backends that
                  launch on their own are not blocked: no approval or budget hook exists yet.
                </p>
                <input aria-label="Costly model patterns" className="h-7 w-full rounded-md border border-border bg-background px-2 text-2xs"
                  value={costlyDraft} onChange={(event) => setCostlyDraft(event.currentTarget.value)} />
                <Button size="xs" variant="outline" onClick={() => {
                  const next = parseCostlyPatterns(costlyDraft);
                  writeCostlyPatterns(next);
                  setCostlyPatterns(next);
                  setCostlyDraft(next.join(", "));
                }}>
                  Save flags
                </Button>
              </section>
              <section aria-label="Communication">
                <h3 className="mb-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">Seat-to-seat messages</h3>
                <p className="text-2xs text-muted-foreground">
                  OpenRig records message attempts and transport outcomes, but no read endpoint exposes them and sender identity is
                  unverified by design. No communication edges are drawn.
                </p>
              </section>
              <section aria-label="Recent ledger events">
                <h3 className="mb-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">Recent ledger events</h3>
                {network.events.length === 0 ? (
                  <p className="text-2xs text-muted-foreground italic">No managed-session events recorded.</p>
                ) : (
                  <ol className="space-y-1 border-l border-border pl-2.5">
                    {network.events.slice(0, 30).map((event) => (
                      <li key={event.key}>
                        <button type="button" className="text-left hover:underline" disabled={!event.seatId}
                          onClick={() => event.seatId && onOpenAgent(event.seatId)}>
                          {event.title}
                        </button>
                        <span className="block text-3xs text-muted-foreground">
                          {formatTimestamp(event.at)}{event.detail ? ` · ${event.detail}` : ""}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
    </OpenRigFloatingWindow>
  );
}

function TreeItem({
  row, index, focused, seatName, costlyPatterns, onFocus, onToggle, onOpenAgent,
}: {
  row: TreeRow;
  index: number;
  focused: boolean;
  seatName: (id: string) => string;
  costlyPatterns: readonly string[];
  onFocus: () => void;
  onToggle: (id: string) => void;
  onOpenAgent: (seatId: string) => void;
}) {
  const indent = { paddingLeft: `${row.depth * 18 + 6}px` };
  if (row.kind === "session")
    return (
      <div role="treeitem" aria-level={row.depth + 1} aria-selected={false} tabIndex={focused ? 0 : -1}
        data-index={index} onFocus={onFocus} style={indent} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <SessionLine session={row.session} seatName={seatName} costlyPatterns={costlyPatterns} onOpenAgent={onOpenAgent} />
      </div>
    );
  const { seat } = row;
  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-selected={false}
      aria-label={`Seat ${seat.name}`}
      tabIndex={focused ? 0 : -1}
      data-index={index}
      onFocus={onFocus}
      style={indent}
      className="flex min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={row.expanded ? `Collapse ${seat.name}` : `Expand ${seat.name}`}
        className={`rounded p-0.5 text-muted-foreground ${row.expandable ? "" : "invisible"}`}
        onClick={() => onToggle(seat.id)}
      >
        {row.expanded ? <ChevronDownIcon className="size-3.5" aria-hidden /> : <ChevronRightIcon className="size-3.5" aria-hidden />}
      </button>
      <span className={`size-2 shrink-0 rounded-full ${SEAT_STATUS_DOT[seatStatusTone(seat.status ?? "unknown")]}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="truncate text-xs font-semibold">{seat.name}</span>
          {seat.role && <span className="text-2xs text-muted-foreground">{seat.role.replaceAll("-", " ")}</span>}
          <span className="text-2xs text-muted-foreground">{seat.status ?? "not in agent list"}</span>
          {seat.rigName && <span className="text-3xs text-muted-foreground">· {seat.rigName}</span>}
        </span>
        <span className="block truncate text-3xs text-muted-foreground">
          {seat.task ? `Task: ${seat.task}` : "No task reported"}
          {` · ${row.sessionCount} session${row.sessionCount === 1 ? "" : "s"}`}
          {row.alsoUnder.length > 0 && ` · also delegated by ${row.alsoUnder.map(seatName).join(", ")}`}
          {!seat.inTopology && " · not in RigSpec topology"}
          {seat.ledger === "failed" && ` · ledger unreadable: ${seat.ledgerError}`}
        </span>
      </span>
      <Button size="xs" variant="ghost-muted" tabIndex={-1} onClick={() => onOpenAgent(seat.id)}>Workspace</Button>
    </div>
  );
}

function SessionLine({ session, seatName, costlyPatterns, onOpenAgent }: {
  session: NetworkSession;
  seatName: (id: string) => string;
  costlyPatterns: readonly string[];
  onOpenAgent: (seatId: string) => void;
}) {
  const costly = isCostlyModel(session.model, costlyPatterns);
  const lineage = [
    session.spawnedFrom &&
      `spawned from seat ${seatName(session.spawnedFrom.seatId)}${session.spawnedFrom.managedSessionId ? ` / session ${session.spawnedFrom.managedSessionId.slice(0, 10)}` : ""}`,
    session.t3Parent &&
      `T3 ${session.t3Parent.relationship ?? "child"} of thread ${session.t3Parent.threadId.slice(0, 10)}${session.t3Parent.ownerSeatId ? ` (owned by ${seatName(session.t3Parent.ownerSeatId)})` : ""}`,
  ].filter(Boolean);
  return (
    <div className={`flex min-w-0 items-start gap-2 rounded-md px-2 py-1 text-2xs ${costly ? "bg-warning/6" : ""}`}>
      <span className={`mt-1 size-1.5 shrink-0 rounded-full ${session.active ? "bg-info" : "bg-muted-foreground/40"}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className={`truncate text-xs ${session.primary ? "font-semibold" : ""}`}>{session.title}</span>
          {session.primary && <Badge variant="info" size="sm">Primary</Badge>}
          {costly && <Badge variant="warning" size="sm" aria-label={`Costly model ${session.model}`}>Costly</Badge>}
          {session.archived && <Badge variant="outline" size="sm">Archived</Badge>}
        </span>
        <span className="block text-muted-foreground">
          {session.provider} · {session.model ?? "model not recorded"}
          {session.effort ? ` · effort ${session.effort}` : ""} · {session.status}
          {session.modelSource !== "T3 thread" && ` · model from ${session.modelSource}`}
          {session.lastActivityAt ? ` · active ${formatTimestamp(session.lastActivityAt)}` : ` · updated ${formatTimestamp(session.updatedAt)}`}
        </span>
        {lineage.length > 0 && <span className="block text-3xs text-muted-foreground">{lineage.join(" · ")}</span>}
      </span>
      {session.seatId && (
        <Button size="xs" variant="ghost-muted" tabIndex={-1} onClick={() => onOpenAgent(session.seatId!)}>Workspace</Button>
      )}
      {session.href && (
        <a className="shrink-0 rounded px-1.5 py-0.5 font-medium text-info hover:bg-muted" tabIndex={-1} href={session.href}
          target={session.href.startsWith("https://") ? "_blank" : undefined}
          rel={session.href.startsWith("https://") ? "noopener noreferrer" : undefined}>
          History
        </a>
      )}
    </div>
  );
}
