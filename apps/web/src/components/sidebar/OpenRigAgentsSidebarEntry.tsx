import type { DesktopOpenRigAgent, DesktopOpenRigSeatTopology } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, NetworkIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuItem } from "../ui/sidebar";
import {
  EMPTY_SEAT_MEMORY,
  OpenRigAgentWorkspace,
  type SeatMemory,
  type WorkspaceTab,
} from "./OpenRigAgentWorkspace";
import { OpenRigAgentNetwork } from "./OpenRigAgentNetwork";
import { SEAT_STATUS_DOT, explanation, seatStatusTone } from "./openRigAgentPresentation";

const REFRESH_INTERVAL_MS = 20_000;

/**
 * Desktop displays OpenRig's authoritative seats and owned sessions; it never
 * assigns them. Rows stay compact; selecting one opens a single floating
 * Agent Workspace that follows the selection.
 */
export function OpenRigAgentsSidebarEntry() {
  const [agents, setAgents] = useState<readonly DesktopOpenRigAgent[]>([]);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [connection, setConnection] = useState<"checking" | "online" | "offline">("checking");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The last snapshot of the selected seat, kept if it leaves the agent list.
  const [selectedAgent, setSelectedAgent] = useState<DesktopOpenRigAgent | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [memory, setMemory] = useState<Readonly<Record<string, SeatMemory>>>({});
  const [topology, setTopology] = useState<DesktopOpenRigSeatTopology | null>(null);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [networkOpen, setNetworkOpen] = useState(false);
  const requestVersion = useRef(0);
  const refreshInFlight = useRef(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const networkButtonRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    // A slow/blocked IPC request may outlive the five-second offline polling interval.
    // Never supersede its result with a newer version or pile up more reads.
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    const version = ++requestVersion.current;
    // Topology is one request for every rig; it fails independently of the agent list.
    void (async () => {
      try {
        const discover = window.desktopBridge?.discoverOpenRigSeats;
        if (!discover) throw new Error("Seat topology IPC is not installed in this desktop build");
        const result = await discover();
        if (version !== requestVersion.current) return;
        setTopology(result);
        setTopologyError(null);
      } catch (error) {
        if (version !== requestVersion.current) return;
        setTopology(null);
        setTopologyError(explanation(error));
      }
    })();
    try {
      const bridge = window.desktopBridge?.listOpenRigAgents;
      if (!bridge) throw new Error("OpenRig desktop bridge unavailable.");
      const snapshot = await bridge();
      if (version !== requestVersion.current) return;
      setAgents(snapshot);
      setSnapshotAt(new Date().toISOString());
      setConnection("online");
      setConnectionError(null);
    } catch (error) {
      if (version !== requestVersion.current) return;
      // A failed agents endpoint does not prove the daemon is down: /healthz may
      // be healthy while a dependent T3 session-enumeration call times out.
      setConnection("offline");
      setConnectionError(explanation(error));
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isElectron) return;
    void refresh();
    return () => { ++requestVersion.current; };
  }, [refresh]);

  useEffect(() => {
    if (!isElectron) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, connection === "offline" ? 5_000 : REFRESH_INTERVAL_MS);
    // Polling is paused in hidden windows; reconnect as soon as T3 is visible.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, connection]);

  const live = selectedId ? agents.find((agent) => agent.id === selectedId) ?? null : null;
  useEffect(() => {
    if (live) setSelectedAgent(live);
  }, [live]);
  const workspaceAgent = live ?? (selectedAgent?.id === selectedId ? selectedAgent : null);

  const close = useCallback(() => {
    const opener = selectedId ? rowRefs.current.get(selectedId) : undefined;
    setSelectedId(null);
    opener?.focus();
  }, [selectedId]);
  const select = (agent: DesktopOpenRigAgent) => {
    if (selectedId === agent.id) return close();
    setSelectedAgent(agent);
    setSelectedId(agent.id);
  };
  const seatNodes = new Map(topology?.seats.map((seat) => [seat.id, seat]) ?? []);
  const seatName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? seatNodes.get(id)?.name ?? id;
  /** Opens (never toggles) a seat's workspace, e.g. from the network or a Team link. */
  const openSeat = (seatId: string) => {
    const known = agents.find((agent) => agent.id === seatId);
    const node = seatNodes.get(seatId);
    if (!known && !node) return;
    // A RigSpec-only seat has no OpenRig agent status; show it as unknown, not idle.
    setSelectedAgent(known ?? {
      id: seatId, name: node!.name, status: "unknown", role: node!.role, task: null,
      bound: false, bindingKind: null, sessionId: null, sessionTitle: null,
    });
    setSelectedId(seatId);
  };
  const closeNetwork = () => {
    setNetworkOpen(false);
    networkButtonRef.current?.focus();
  };
  const updateMemory = useCallback((seatId: string, update: (current: SeatMemory) => SeatMemory) => {
    setMemory((prior) => ({ ...prior, [seatId]: update(prior[seatId] ?? EMPTY_SEAT_MEMORY) }));
  }, []);
  const listKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = agents.map((agent) => rowRefs.current.get(agent.id)).filter((row) => row !== undefined);
    const index = rows.findIndex((row) => row === document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    rows[event.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1)]?.focus();
  };

  if (!isElectron) return null;
  return (
    <>
    <div className="mt-1 border-t border-sidebar-border/60 pt-1" onKeyDown={listKeyDown}>
      <SidebarMenu aria-label="OpenRig agents">
        <SidebarMenuItem>
          <div className="flex min-w-0 items-center gap-1 px-2">
            <button type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs font-semibold text-sidebar-muted-foreground hover:text-sidebar-foreground"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand OpenRig agents" : "Collapse OpenRig agents"}
              onClick={() => setCollapsed((current) => !current)}>
              {collapsed ? <ChevronDownIcon className="size-3" /> : <ChevronUpIcon className="size-3" />}
              <span>OpenRig</span>
              {connection === "online" && <span className="font-normal">({agents.length})</span>}
            </button>
            <span className="text-2xs text-sidebar-muted-foreground" role="status" title={connectionError ?? undefined}>
              {connection === "checking" ? "Checking…" : connection === "offline" ? "Reconnecting…" : ""}
            </span>
            <Button
              ref={networkButtonRef}
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Open OpenRig agent network"
              aria-haspopup="dialog"
              aria-expanded={networkOpen}
              onClick={() => (networkOpen ? closeNetwork() : setNetworkOpen(true))}
            >
              <NetworkIcon aria-hidden />
            </Button>
            <Button size="icon-xs" variant="ghost-muted" aria-label="Refresh OpenRig agents" onClick={() => void refresh()}>
              <RefreshCwIcon aria-hidden />
            </Button>
          </div>
        </SidebarMenuItem>
        {!collapsed && connection === "online" && agents.length === 0 && (
          <SidebarMenuItem>
            <span className="block px-2 py-1 text-xs text-sidebar-muted-foreground">No OpenRig agents</span>
          </SidebarMenuItem>
        )}
        {!collapsed && agents.map((agent) => {
          const selected = agent.id === selectedId;
          return (
            <SidebarMenuItem key={agent.id}>
              <button
                ref={(node) => { if (node) rowRefs.current.set(agent.id, node); else rowRefs.current.delete(agent.id); }}
                type="button"
                className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring ${selected ? "bg-sidebar-row-hover" : ""}`}
                aria-label={`Open workspace for OpenRig agent ${agent.name}`}
                aria-haspopup="dialog"
                aria-expanded={selected}
                onClick={() => select(agent)}
              >
                <span className={`size-2 shrink-0 rounded-full ${SEAT_STATUS_DOT[seatStatusTone(agent.status)]}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sidebar-foreground">{agent.name}</span>
                  {agent.role && (
                    <span className="block truncate text-2xs text-sidebar-muted-foreground">{agent.role.replaceAll("-", " ")}</span>
                  )}
                </span>
                <span className="shrink-0 text-2xs text-sidebar-muted-foreground">{agent.status}</span>
              </button>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </div>
      {workspaceAgent && createPortal(
        <OpenRigAgentWorkspace
          key={workspaceAgent.id}
          agent={workspaceAgent}
          staleReason={connection !== "online"
            ? `T3 could not refresh OpenRig seats; retrying automatically. The daemon may still be healthy. Showing the last confirmed seat details.${connectionError ? ` Last error: ${connectionError}` : ""}`
            : live ? null : `${workspaceAgent.name} is not in OpenRig's latest agent snapshot. Details below may be stale.`}
          snapshotAt={snapshotAt}
          tab={tab}
          onTabChange={setTab}
          memory={memory[workspaceAgent.id] ?? EMPTY_SEAT_MEMORY}
          onMemoryChange={(update) => updateMemory(workspaceAgent.id, update)}
          onAgentsChanged={refresh}
          onClose={close}
          seatNode={seatNodes.get(workspaceAgent.id) ?? null}
          topologyAvailable={topology !== null}
          seatName={seatName}
          onOpenAgent={openSeat}
          onOpenNetwork={() => setNetworkOpen(true)}
        />,
        document.body,
      )}
      {networkOpen && createPortal(
        <OpenRigAgentNetwork
          agents={agents}
          topology={topology}
          topologyError={topologyError}
          onRefreshAgents={refresh}
          onOpenAgent={openSeat}
          onClose={closeNetwork}
        />,
        document.body,
      )}
    </>
  );
}
