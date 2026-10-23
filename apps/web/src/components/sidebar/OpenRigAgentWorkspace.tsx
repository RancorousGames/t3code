import type {
  DesktopOpenRigAgent,
  DesktopOpenRigAgentTasks,
  DesktopOpenRigAgentTask,
  DesktopOpenRigExecutionProfile,
  DesktopOpenRigExecutionProfileRecord,
  DesktopOpenRigManagedSession,
  DesktopOpenRigManagedBrowserLifecycleInput,
  DesktopOpenRigManagedBrowserLifecycleResult,
  DesktopOpenRigSeatNode,
  DesktopOpenRigSeatReport,
  DesktopOpenRigSeatSessions,
  DesktopOpenRigSession,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  ActivityIcon,
  BrainIcon,
  BriefcaseIcon,
  LayersIcon,
  MessageSquareIcon,
  NetworkIcon,
  RefreshCwIcon,
  SendIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { randomUUID } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { OpenRigAgentTranscript } from "./OpenRigAgentTranscript";
import { OpenRigFloatingWindow, type FloatingSize } from "./OpenRigFloatingWindow";
import { isCostlyModel, readCostlyPatterns, selectionEffort } from "./openRigCostPolicy";
import { OpenRigCanonicalSpawnApprovals } from "./OpenRigSpawnApproval";
import {
  SEAT_STATUS_BADGE,
  SEAT_STATUS_DOT,
  buildActivity,
  canMessagePrimary,
  explanation,
  formatTimestamp,
  historyHref,
  isPreIntentLaunchRejection,
  primarySession,
  seatBlockers,
  seatStatusTone,
  sessionDisplayTitle,
  sessionObservedStatus,
  sessionProviderLabel,
  type WorkspaceSend,
} from "./openRigAgentPresentation";

export type WorkspaceTab = "overview" | "work" | "sessions" | "activity" | "memory" | "settings";
const TABS: readonly { id: WorkspaceTab; label: string; icon: typeof ActivityIcon }[] = [
  { id: "overview", label: "Overview", icon: MessageSquareIcon },
  { id: "work", label: "Work", icon: BriefcaseIcon },
  { id: "sessions", label: "Sessions", icon: LayersIcon },
  { id: "activity", label: "Activity", icon: ActivityIcon },
  { id: "memory", label: "Memory", icon: BrainIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];
const GEOMETRY_KEY = "t3code:openrig-agent-workspace-geometry:v1";
const LEDGER_REFRESH_MS = 60_000;
const MIN_SIZE: FloatingSize = { width: 360, height: 420 };

/** Seat state that must survive switching the workspace to another agent. */
export interface SeatMemory {
  draft: string;
  /** A launch/adoption whose outcome is unknown. Blocks another until inspected. */
  unresolvedOperationId: string | null;
  sends: readonly WorkspaceSend[];
}
export const EMPTY_SEAT_MEMORY: SeatMemory = { draft: "", unresolvedOperationId: null, sends: [] };

function defaultWorkspaceGeometry(viewport: FloatingSize) {
  const wide = viewport.width >= 1200;
  const left = wide ? 340 : 16;
  return {
    left,
    top: 56,
    width: Math.min(1120, viewport.width - left - 24),
    height: Math.min(800, viewport.height - 80),
  };
}

type RuntimeMode = "" | DesktopOpenRigExecutionProfileRecord["runtimeMode"];
const inputClass = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs";

function useOpenRigSeat(seatId: string) {
  const [ledger, setLedger] = useState<DesktopOpenRigSeatSessions | null>(null);
  const [ledgerError, setLedgerError] = useState("");
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [profile, setProfile] = useState<DesktopOpenRigExecutionProfile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [profileLoading, setProfileLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [mutating, setMutating] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [reports, setReports] = useState<readonly DesktopOpenRigSeatReport[] | null>(null);
  const [reportsError, setReportsError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const method = window.desktopBridge?.readOpenRigSeatReports;
        if (!method) throw new Error("Seat report IPC is not installed in this desktop build.");
        const result = await method(seatId);
        if (!active) return;
        setReports(result.reports);
        setReportsError("");
      } catch (error) {
        if (!active) return;
        setReports(null);
        setReportsError(explanation(error));
      }
    })();
    return () => { active = false; };
  }, [seatId, revision]);

  useEffect(() => {
    let active = true;
    setLedgerLoading(true);
    void (async () => {
      try {
        const method = window.desktopBridge?.listOpenRigManagedSessions;
        if (!method) throw new Error("Managed session IPC is not installed. Update T3.");
        const result = await method(seatId);
        if (!active) return;
        setLedger(result);
        setLedgerError("");
      } catch (error) {
        if (!active) return;
        setLedger(null);
        setLedgerError(explanation(error));
      } finally {
        if (active) setLedgerLoading(false);
      }
    })();
    return () => { active = false; };
  }, [seatId, revision]);

  useEffect(() => {
    let active = true;
    setProfileLoading(true);
    void (async () => {
      try {
        const method = window.desktopBridge?.readOpenRigExecutionProfile;
        if (!method) throw new Error("Execution profile IPC is not installed. Deploy updated T3.");
        const result = await method(seatId);
        if (!active) return;
        setProfile(result);
        setProfileError("");
      } catch (error) {
        if (!active) return;
        setProfile(null);
        setProfileError(explanation(error));
      } finally {
        if (active) setProfileLoading(false);
      }
    })();
    return () => { active = false; };
  }, [seatId, revision]);

  useEffect(() => {
    const timer = window.setInterval(() => setRevision((current) => current + 1), LEDGER_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  return {
    ledger, setLedger, ledgerError, ledgerLoading,
    profile, setProfile, setProfileError, profileError, profileLoading,
    mutating, setMutating, profileSaving, setProfileSaving, refresh,
    reports, reportsError, revision,
  };
}
type Seat = ReturnType<typeof useOpenRigSeat>;

type CanonicalTasksRead =
  | { agentId: string; status: "loading" }
  | { agentId: string; status: "ready"; page: Extract<DesktopOpenRigAgentTasks, { available: true }> }
  | { agentId: string; status: "unavailable"; reason: Extract<DesktopOpenRigAgentTasks, { available: false }>["error"] }
  | { agentId: string; status: "error"; message: string };


function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-background/40 px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {action}
      </div>
      <div className="text-xs leading-relaxed">{children}</div>
    </section>
  );
}
function Unexposed({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground italic">{children}</p>;
}
function Notice({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warning" }) {
  return (
    <div
      role="alert"
      className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${tone === "warning" ? "border-warning/40 bg-warning/8 text-warning-foreground" : "border-border bg-muted/30 text-muted-foreground"}`}
    >
      {children}
    </div>
  );
}

export function OpenRigAgentWorkspace({
  agent,
  staleReason,
  snapshotAt,
  tab,
  onTabChange,
  memory,
  onMemoryChange,
  onAgentsChanged,
  onClose,
  seatNode,
  topologyAvailable,
  seatName,
  onOpenAgent,
  onOpenNetwork,
}: {
  agent: DesktopOpenRigAgent;
  /** Set when these seat details are not from OpenRig's latest successful snapshot. */
  staleReason: string | null;
  snapshotAt: string | null;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  memory: SeatMemory;
  onMemoryChange: (update: (current: SeatMemory) => SeatMemory) => void;
  onAgentsChanged: () => Promise<void>;
  onClose: () => void;
  /** This seat in OpenRig's RigSpec topology; null when absent or unavailable. */
  seatNode: DesktopOpenRigSeatNode | null;
  topologyAvailable: boolean;
  seatName: (seatId: string) => string;
  onOpenAgent: (seatId: string) => void;
  onOpenNetwork: () => void;
}) {
  const seat = useOpenRigSeat(agent.id);
  const [taskRead, setTaskRead] = useState<CanonicalTasksRead | null>(null);
  const taskAgentId = seatNode?.id === agent.id ? seatNode.id : null;
  useEffect(() => {
    if (tab !== "work" || !taskAgentId) return;
    let active = true;
    setTaskRead({ agentId: taskAgentId, status: "loading" });
    void (async () => {
      try {
        const method = window.desktopBridge?.readOpenRigAgentTasks;
        if (!method) throw new Error("Canonical task read IPC is not installed in this desktop build.");
        const result = await method(taskAgentId);
        if (!active) return;
        setTaskRead(result.available
          ? { agentId: taskAgentId, status: "ready", page: result }
          : { agentId: taskAgentId, status: "unavailable", reason: result.error });
      } catch (error) {
        if (active) setTaskRead({ agentId: taskAgentId, status: "error", message: explanation(error) });
      }
    })();
    return () => { active = false; };
  }, [tab, taskAgentId, seat.revision]);
  const selectedTaskRead = taskAgentId && taskRead?.agentId === taskAgentId ? taskRead : null;
  const primary = primarySession(seat.ledger);
  const canSend = canMessagePrimary(primary);
  const blockers = seatBlockers(agent, seat.ledger, seat.profile);
  const tone = seatStatusTone(agent.status);
  const tabRefs = useRef(new Map<WorkspaceTab, HTMLButtonElement>());
  const changed = useCallback(async () => { await onAgentsChanged(); }, [onAgentsChanged]);

  const tabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((entry) => entry.id === tab);
    const next = event.key === "ArrowRight" ? (index + 1) % TABS.length
      : event.key === "ArrowLeft" ? (index - 1 + TABS.length) % TABS.length
        : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onTabChange(TABS[next]!.id);
    tabRefs.current.get(TABS[next]!.id)?.focus();
  };

  return (
    <OpenRigFloatingWindow
      id="openrig-agent-workspace"
      label={`OpenRig agent workspace: ${agent.name}`}
      storageKey={GEOMETRY_KEY}
      defaultGeometry={defaultWorkspaceGeometry}
      minSize={MIN_SIZE}
      compactBelow={780}
      onEscape={onClose}
      header={() => (
        <header className="flex items-start gap-3 border-b border-border px-4 py-3">
          <span
            aria-hidden
            className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-base font-semibold"
          >
            {agent.name.slice(0, 1).toUpperCase()}
            <span className={`absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-popover ${SEAT_STATUS_DOT[tone]}`} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-semibold">{agent.name}</h2>
              <Badge variant={SEAT_STATUS_BADGE[tone]} aria-label={`OpenRig status: ${agent.status}`}>{agent.status}</Badge>
              {agent.role && <Badge variant="secondary">{agent.role.replaceAll("-", " ")}</Badge>}
            </div>
            <p className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-2xs text-muted-foreground">
              <span className="font-mono" aria-label="OpenRig seat ID">{agent.id}</span>
              {primary?.projectId && <span>· Project {primary.projectId}</span>}
              {primary && <span>· Primary: {sessionProviderLabel(primary)}</span>}
              {snapshotAt && <span>· Status as of {formatTimestamp(snapshotAt)}</span>}
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={`Refresh workspace for ${agent.name}`}
            disabled={seat.ledgerLoading}
            onClick={() => { seat.refresh(); void changed(); }}
          >
            <RefreshCwIcon aria-hidden />
          </Button>
          <Button size="icon-sm" variant="ghost-muted" aria-label="Close agent workspace" onClick={onClose}>
            <XIcon aria-hidden />
          </Button>
        </header>
      )}
    >
      {({ compact }) => (
        <>
          {staleReason && (
            <div className="mx-4 mt-2">
              <Notice tone="warning">{staleReason}</Notice>
            </div>
          )}
          <div
            role="tablist"
            aria-label={`Workspace sections for ${agent.name}`}
            className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-3"
            onKeyDown={tabKeyDown}
          >
            {TABS.map(({ id, label, icon: Icon }) => {
              const count = id === "sessions" ? seat.ledger?.sessions.length : id === "work" ? blockers.length || undefined : undefined;
              return (
                <button
                  key={id}
                  ref={(node) => { if (node) tabRefs.current.set(id, node); else tabRefs.current.delete(id); }}
                  type="button"
                  role="tab"
                  id={`openrig-workspace-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`openrig-workspace-panel-${id}`}
                  tabIndex={tab === id ? 0 : -1}
                  className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-xs font-medium ${tab === id ? "border-info text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                  onClick={() => onTabChange(id)}
                >
                  <Icon className="size-3.5" aria-hidden />
                  {label}
                  {count ? (
                    <span className={`rounded-full px-1.5 text-3xs ${id === "work" ? "bg-warning/15 text-warning" : "bg-muted"}`}>{count}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <TabPanel id="overview" tab={tab}>
            <div className={`grid min-h-0 flex-1 ${compact ? "grid-cols-1 grid-rows-[minmax(0,1fr)_auto] overflow-y-auto" : "grid-cols-[minmax(0,1fr)_minmax(250px,300px)]"}`}>
              <ChatPanel
                agent={agent}
                seat={seat}
                primary={primary}
                canSend={canSend}
                active={tab === "overview"}
                memory={memory}
                onMemoryChange={onMemoryChange}
                onManageSessions={() => onTabChange("sessions")}
              />
              <aside
                aria-label={`Context for ${agent.name}`}
                className={`min-h-0 space-y-2 overflow-y-auto p-3 ${compact ? "border-t border-border" : "border-l border-border bg-muted/10"}`}
              >
                <Card title="Current task">
                  {agent.task ? <p className="break-words">{agent.task}</p> : <Unexposed>OpenRig reports no current task.</Unexposed>}
                </Card>
                <BlockersCard blockers={blockers} />
                <PrimaryCard primary={primary} loading={seat.ledgerLoading && !seat.ledger} />
                <TeamCard ledger={seat.ledger} seatNode={seatNode} topologyAvailable={topologyAvailable}
                  seatName={seatName} onOpenAgent={onOpenAgent} onOpenNetwork={onOpenNetwork} />
                <Card title="Spawn approvals">
                  {tab === "overview" && <OpenRigCanonicalSpawnApprovals seatId={agent.id} seatName={seatName} />}
                </Card>
              </aside>
            </div>
          </TabPanel>
          <TabPanel id="work" tab={tab} scroll>
            <Card title="Current task">
              {agent.task ? <p className="break-words">{agent.task}</p> : <Unexposed>OpenRig reports no current task.</Unexposed>}
            </Card>
            <BlockersCard blockers={blockers} />
            <ReportsCard reports={seat.reports} error={seat.reportsError} seatName={seatName} />
            <TeamCard ledger={seat.ledger} seatNode={seatNode} topologyAvailable={topologyAvailable}
              seatName={seatName} onOpenAgent={onOpenAgent} onOpenNetwork={onOpenNetwork} />
            <CanonicalTasksCard taskRead={selectedTaskRead} knownSeat={Boolean(taskAgentId)} />
          </TabPanel>
          <TabPanel id="sessions" tab={tab} scroll>
            {tab === "sessions" && <OpenRigCanonicalSpawnApprovals seatId={agent.id} seatName={seatName} />}
            <SessionsPanel key={agent.id} agent={agent} seat={seat} memory={memory} onMemoryChange={onMemoryChange} onChanged={changed} />
          </TabPanel>
          <TabPanel id="activity" tab={tab} scroll>
            <ActivityPanel agent={agent} snapshotAt={snapshotAt} ledger={seat.ledger} sends={memory.sends}
              reports={seat.reports} />
          </TabPanel>
          <TabPanel id="memory" tab={tab} scroll>
            <MemoryPanel agent={agent} profile={seat.profile} />
          </TabPanel>
          <TabPanel id="settings" tab={tab} scroll>
            <SettingsPanel agent={agent} seat={seat} />
          </TabPanel>
        </>
      )}
    </OpenRigFloatingWindow>
  );
}

function TabPanel({ id, tab, scroll = false, children }: { id: WorkspaceTab; tab: WorkspaceTab; scroll?: boolean; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={`openrig-workspace-panel-${id}`}
      aria-labelledby={`openrig-workspace-tab-${id}`}
      hidden={tab !== id}
      className={tab !== id ? "hidden" : scroll
        ? "min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4"
        : "flex min-h-0 flex-1 flex-col"}
    >
      {children}
    </div>
  );
}

function CanonicalTasksCard({
  taskRead, knownSeat,
}: {
  taskRead: CanonicalTasksRead | null;
  knownSeat: boolean;
}) {
  return (
    <Card title="Canonical queue assignments and evidence">
      {!knownSeat ? (
        <Notice tone="warning">No exact RigSpec node ID is available for this seat. Tasks were not queried.</Notice>
      ) : !taskRead || taskRead.status === "loading" ? (
        <p role="status" className="text-muted-foreground">Loading canonical queue tasks…</p>
      ) : taskRead.status === "error" ? (
        <Notice tone="warning">Task read failed: {taskRead.message}. No current task state is verified.</Notice>
      ) : taskRead.status === "unavailable" ? (
        <Notice tone="warning">
          {taskRead.reason === "agent_not_found" ? "OpenRig does not recognize this node ID."
            : taskRead.reason === "ambiguous_canonical_seat" ? "Canonical seat address is ambiguous."
              : taskRead.reason === "canonical_task_read_model_unavailable" ? "Canonical queue read model is unavailable."
                : "OpenRig rejected the task read limit."} No empty queue is inferred.
        </Notice>
      ) : taskRead.page.tasks.length === 0 ? (
        <Unexposed>Canonical task read succeeded. No queued tasks for {taskRead.page.agent.canonicalSession}.</Unexposed>
      ) : (
        <>
          <p className="mb-2 text-3xs text-muted-foreground">
            Canonical queue state, not browser health or message-delivery acknowledgement.
            {taskRead.page.hasMore ? " Showing the latest 25; additional tasks exist." : ""}
          </p>
          <ul aria-label="Canonical OpenRig tasks" className="space-y-2">
            {taskRead.page.tasks.map((task) => <CanonicalTaskItem key={task.qitemId} task={task} />)}
          </ul>
        </>
      )}
    </Card>
  );
}

function CanonicalTaskDetail({ label, value }: { label: string; value: string | null | undefined }) {
  if (value == null || value === "") return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </>
  );
}

function CanonicalTaskItem({ task }: { task: DesktopOpenRigAgentTask }) {
  return (
    <li className="space-y-1 rounded-lg border border-border bg-muted/10 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <strong className="break-all font-mono text-2xs" aria-label="Canonical queue task ID">{task.qitemId}</strong>
        <Badge variant="secondary" aria-label={`Canonical task state: ${task.state}`}>{task.state}</Badge>
      </div>
      <p className="break-words text-xs">{task.summary ?? "No persisted summary"}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-3xs">
        <CanonicalTaskDetail label="From" value={task.sourceSession} />
        <CanonicalTaskDetail label="To" value={task.destinationSession} />
        <CanonicalTaskDetail label="Handed off from" value={task.handedOffFrom} />
        <CanonicalTaskDetail label="Handed off to" value={task.handedOffTo} />
        <CanonicalTaskDetail label="Chain of record" value={task.chainOfRecord?.join(" → ")} />
        <CanonicalTaskDetail label="Evidence reference" value={task.evidenceRef} />
        <CanonicalTaskDetail label="Closure reason" value={task.closureReason} />
        <CanonicalTaskDetail label="Closure target" value={task.closureTarget} />
        <CanonicalTaskDetail label="Resolution" value={task.resolution} />
        <CanonicalTaskDetail label="Created" value={task.tsCreated} />
        <CanonicalTaskDetail label="Updated" value={task.tsUpdated} />
        <CanonicalTaskDetail label="Claimed" value={task.claimedAt} />
        <CanonicalTaskDetail label="Last nudge attempted" value={task.lastNudgeAttempt} />
        <CanonicalTaskDetail label="Delivery diagnostic (not completion)" value={task.lastNudgeResult} />
        {task.lastTransition && (
          <CanonicalTaskDetail
            label="Last persisted transition"
            value={`#${task.lastTransition.transitionId}: ${task.lastTransition.state} · ${task.lastTransition.actorSession} · ${task.lastTransition.ts}`}
          />
        )}
        <CanonicalTaskDetail label="Transition note" value={task.lastTransition?.transitionNote} />
        <CanonicalTaskDetail label="Transition closure reason" value={task.lastTransition?.closureReason} />
        <CanonicalTaskDetail label="Transition closure target" value={task.lastTransition?.closureTarget} />
      </dl>
    </li>
  );
}

function BlockersCard({ blockers }: { blockers: ReturnType<typeof seatBlockers> }) {
  return (
    <Card title="Blockers">
      {blockers.length === 0 ? (
        <Unexposed>No blocking conditions in the data OpenRig exposes to T3.</Unexposed>
      ) : (
        <ul className="list-disc space-y-1 pl-4">
          {blockers.map((blocker) => <li key={blocker.key}>{blocker.text}</li>)}
        </ul>
      )}
    </Card>
  );
}

function PrimaryCard({ primary, loading }: { primary: DesktopOpenRigManagedSession | null; loading: boolean }) {
  return (
    <Card title="Primary session">
      {loading ? (
        <p role="status" className="text-muted-foreground">Loading…</p>
      ) : !primary ? (
        <Unexposed>No primary session selected in OpenRig.</Unexposed>
      ) : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          <dt className="text-muted-foreground">Title</dt><dd className="truncate">{sessionDisplayTitle(primary)}</dd>
          <dt className="text-muted-foreground">Provider</dt><dd>{sessionProviderLabel(primary)}</dd>
          <dt className="text-muted-foreground">Ledger status</dt><dd>{primary.status}</dd>
          <dt className="text-muted-foreground">Last activity</dt>
          <dd>{formatTimestamp(primary.lastActivityAt) ?? "Not reported"}</dd>
          <dt className="text-muted-foreground">Updated</dt><dd>{formatTimestamp(primary.updatedAt)}</dd>
        </dl>
      )}
    </Card>
  );
}

function TeamCard({
  ledger, seatNode, topologyAvailable, seatName, onOpenAgent, onOpenNetwork,
}: {
  ledger: DesktopOpenRigSeatSessions | null;
  seatNode: DesktopOpenRigSeatNode | null;
  topologyAvailable: boolean;
  seatName: (seatId: string) => string;
  onOpenAgent: (seatId: string) => void;
  onOpenNetwork: () => void;
}) {
  const spawned = (ledger?.sessions ?? []).filter((session) => session.parentSeatId);
  const seatList = (label: string, ids: readonly string[]) => ids.length > 0 && (
    <div>
      <p className="text-2xs font-medium text-muted-foreground">{label}</p>
      <ul className="mt-0.5 flex flex-wrap gap-1">
        {ids.map((id) => (
          <li key={id}><Button size="xs" variant="outline" onClick={() => onOpenAgent(id)}>{seatName(id)}</Button></li>
        ))}
      </ul>
    </div>
  );
  return (
    <Card
      title="Team"
      action={<Button size="xs" variant="ghost-muted" onClick={onOpenNetwork}><NetworkIcon aria-hidden />Network</Button>}
    >
      {!topologyAvailable ? (
        <Unexposed>OpenRig&apos;s seat hierarchy is unavailable right now; no manager or report links are guessed.</Unexposed>
      ) : !seatNode ? (
        <Unexposed>This seat is not in OpenRig&apos;s RigSpec topology.</Unexposed>
      ) : seatNode.parentIds.length === 0 && seatNode.childIds.length === 0 ? (
        <Unexposed>RigSpec declares no delegation edges for this seat{seatNode.rigName ? ` in ${seatNode.rigName}` : ""}.</Unexposed>
      ) : (
        <div className="space-y-1.5">
          {seatList("Delegated by (RigSpec)", seatNode.parentIds)}
          {seatList("Delegates to (RigSpec)", seatNode.childIds)}
        </div>
      )}
      {spawned.length > 0 && (
        <div className="mt-2">
          <p className="text-2xs font-medium text-muted-foreground">Session spawn lineage (not a reporting line)</p>
          <ul className="mt-1 space-y-0.5">
            {spawned.map((session) => (
              <li key={session.id} className="break-words">
                {sessionDisplayTitle(session)} ← seat <span className="font-mono">{seatName(session.parentSeatId!)}</span>
                {session.parentManagedSessionId && <> / session <span className="font-mono">{session.parentManagedSessionId.slice(0, 12)}</span></>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function ReportsCard({ reports, error, seatName }: {
  reports: readonly DesktopOpenRigSeatReport[] | null;
  error: string;
  seatName: (seatId: string) => string;
}) {
  const latest = reports?.[0];
  return (
    <Card title="Latest status report">
      {error ? (
        <Unexposed>Seat reports unavailable: {error}</Unexposed>
      ) : !reports ? (
        <p role="status" className="text-muted-foreground">Loading…</p>
      ) : !latest ? (
        <Unexposed>No status reports posted for this seat.</Unexposed>
      ) : (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={latest.status === "blocked" || latest.status === "failed" ? "error" : latest.status === "completed" ? "success" : "info"}>
              {latest.status}
            </Badge>
            <span className="text-2xs text-muted-foreground">{formatTimestamp(latest.timestamp)}</span>
            {latest.progress !== null && <span className="text-2xs text-muted-foreground">self-reported {latest.progress}%</span>}
          </div>
          <p className="break-words">{latest.summary}</p>
          {latest.blockedOn.length > 0 && (
            <p className="text-2xs text-muted-foreground">Blocked on: {latest.blockedOn.map(seatName).join(", ")}</p>
          )}
          <p className="text-3xs text-muted-foreground">Author not verified; completion is not verified by OpenRig.</p>
        </div>
      )}
    </Card>
  );
}

function ChatPanel({
  agent, seat, primary, canSend, active, memory, onMemoryChange, onManageSessions,
}: {
  agent: DesktopOpenRigAgent;
  seat: Seat;
  primary: DesktopOpenRigManagedSession | null;
  canSend: boolean;
  active: boolean;
  memory: SeatMemory;
  onMemoryChange: (update: (current: SeatMemory) => SeatMemory) => void;
  onManageSessions: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const draft = memory.draft;
  const setDraft = (value: string) => onMemoryChange((current) => ({ ...current, draft: value }));
  const href = historyHref(primary?.target ?? null);

  async function submit() {
    if (sending || !draft.trim() || !canSend) return;
    const text = draft;
    setSending(true);
    setFeedback("");
    const record = (outcome: WorkspaceSend["outcome"], detail: string | null) =>
      onMemoryChange((current) => ({
        ...current,
        ...(outcome === "accepted" ? { draft: "" } : {}),
        sends: [...current.sends, { id: randomUUID(), seatId: agent.id, text, at: new Date().toISOString(), outcome, detail }].slice(-50),
      }));
    try {
      const method = window.desktopBridge?.sendOpenRigAgentMessage;
      if (!method) throw new Error("OpenRig messaging is unavailable.");
      // Address the stable seat; OpenRig alone resolves active/primary delivery.
      await method({ id: agent.id, message: text });
      record("accepted", null);
      setFeedback("T3 accepted the message; agent read/reply not confirmed.");
    } catch (error) {
      record("unconfirmed", explanation(error));
      setFeedback("Delivery unconfirmed: " + explanation(error) + " Check history before retrying.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2 text-2xs text-muted-foreground">
        {primary ? (
          <>
            <span>Delivering to primary</span>
            <span className="min-w-0 truncate font-medium text-foreground">{sessionDisplayTitle(primary)}</span>
            <Badge variant="outline">{sessionProviderLabel(primary)}</Badge>
            <span>{primary.status}</span>
          </>
        ) : (
          <span>No primary session</span>
        )}
        <span className="flex-1" />
        <Button size="xs" variant="ghost-muted" onClick={onManageSessions}>Manage sessions</Button>
      </div>
      <div className="flex min-h-48 flex-1 flex-col">
        {seat.ledgerLoading && !seat.ledger && (
          <p role="status" className="p-4 text-xs text-muted-foreground">Loading OpenRig-owned sessions…</p>
        )}
        {seat.ledgerError && (
          <div role="alert" className="m-4 space-y-2 rounded-lg border border-warning/40 bg-warning/8 p-3 text-xs">
            <p>Managed sessions unavailable: {seat.ledgerError}</p>
            <Button size="xs" variant="outline" onClick={seat.refresh}>Retry</Button>
          </div>
        )}
        {active && primary?.status === "active" && primary.target?.kind === "t3-thread" && href ? (
          <OpenRigAgentTranscript
            agentName={agent.name}
            environmentId={primary.target.environmentId}
            threadId={primary.target.threadId}
            historyHref={href}
          />
        ) : primary?.target?.kind === "chatgpt-conversation" && href ? (
          <p className="px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            This seat&apos;s primary is a ChatGPT conversation. T3 does not mirror ChatGPT transcripts here;{" "}
            <a className="underline" href={href} target="_blank" rel="noopener noreferrer">open it in ChatGPT</a>.
          </p>
        ) : seat.ledger ? (
          <p className="px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
            No readable transcript. A transcript appears here when OpenRig confirms an active native T3 primary.
          </p>
        ) : null}
        {memory.sends.length > 0 && (
          <div className="shrink-0 border-t border-border/60 px-4 py-2">
            <p className="text-3xs font-medium text-muted-foreground uppercase">Sent from this workspace · this app session only</p>
            <ul aria-label={`Messages sent to ${agent.name} from this workspace`} className="mt-1 max-h-28 space-y-1 overflow-y-auto">
              {memory.sends.map((send) => (
                <li key={send.id} className="flex items-start gap-2 text-2xs">
                  <span className={send.outcome === "accepted" ? "text-muted-foreground" : "font-semibold text-warning"}>
                    {send.outcome === "accepted" ? "Accepted" : "Unconfirmed"}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{send.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border p-3">
        {canSend ? (
          <form
            className="space-y-1.5"
            onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void submit(); }}
          >
            <Textarea
              size="sm"
              rows={3}
              aria-label={`Message to ${agent.name}`}
              placeholder={`Message ${agent.name}… (Ctrl+Enter to send)`}
              value={draft}
              maxLength={8_000}
              disabled={sending}
              onChange={(event) => { setDraft(event.currentTarget.value); setFeedback(""); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span role="status" className="min-w-0 text-2xs text-muted-foreground">{feedback}</span>
              <Button type="submit" size="sm" disabled={sending || !draft.trim()}>
                <SendIcon aria-hidden />{sending ? "Sending…" : "Send"}
              </Button>
            </div>
          </form>
        ) : seat.ledger ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1">
              No routable active managed primary. Messaging requires OpenRig to confirm an exact provider conversation and
              select it as primary; legacy bindings cannot receive seat messages.
            </span>
            <Button size="xs" variant="outline" onClick={onManageSessions}>Open Sessions</Button>
          </div>
        ) : null}
        {!canSend && feedback && <span role="status" className="block text-2xs text-muted-foreground">{feedback}</span>}
      </div>
    </div>
  );
}

function SessionsPanel({
  agent, seat, memory, onMemoryChange, onChanged,
}: {
  agent: DesktopOpenRigAgent;
  seat: Seat;
  memory: SeatMemory;
  onMemoryChange: (update: (current: SeatMemory) => SeatMemory) => void;
  onChanged: () => Promise<void>;
}) {
  const { ledger, profile, mutating, setMutating, profileSaving } = seat;
  const [feedback, setFeedback] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [available, setAvailable] = useState<readonly DesktopOpenRigSession[]>([]);
  const [chosen, setChosen] = useState("");
  const [filter, setFilter] = useState("");
  const [launchKind, setLaunchKind] = useState<"" | "native" | "chatgpt">("");
  const [launchRoot, setLaunchRoot] = useState("");
  const [launchTitle, setLaunchTitle] = useState("");
  const [launchPrompt, setLaunchPrompt] = useState("");
  const [launchParentSeatId, setLaunchParentSeatId] = useState("");
  const [launchParentManagedSessionId, setLaunchParentManagedSessionId] = useState("");
  const [showLaunchOptions, setShowLaunchOptions] = useState(false);
  const [detachConfirmation, setDetachConfirmation] = useState<string | null>(null);
  const [closeConfirmation, setCloseConfirmation] = useState<string | null>(null);
  const [lifecycleReceipt, setLifecycleReceipt] = useState<DesktopOpenRigManagedBrowserLifecycleResult | null>(null);
  const [uncertainLifecycleSession, setUncertainLifecycleSession] = useState<string | null>(null);
  // Seat-keyed SessionsPanel remounts on selection. Ignore late receipts
  // from the previous seat without resetting another seat's browser/drafts.
  const lifecycleGeneration = useRef(0);
  useEffect(() => () => { ++lifecycleGeneration.current; }, []);
  const unresolvedOperationId = memory.unresolvedOperationId;
  const setUnresolved = (value: string | null) =>
    onMemoryChange((current) => ({ ...current, unresolvedOperationId: value }));

  useEffect(() => {
    if (!advanced) return;
    let active = true;
    void window.desktopBridge?.listOpenRigSessions?.()
      .then((result) => { if (active) setAvailable(result); })
      .catch((error: unknown) => {
        if (active) setFeedback("Cannot list unmanaged conversations: " + explanation(error));
      });
    return () => { active = false; };
  }, [advanced]);

  const hasManaged = (ledger?.sessions.length ?? 0) > 0;
  const seatRuntime = profile?.rigSpec.runtime?.toLowerCase();
  // An unknown/unreadable profile must not make native execution appear ready.
  // An explicit ChatGPT execution is independent of native profile readiness.
  const nativeRequested = launchKind === "native" || (launchKind === "" && seatRuntime !== "chatgpt");
  const nativeBlocked = nativeRequested && (!profile || !profile.nativeLaunchReady);

  // The model a native launch will use as OpenRig resolves it (saved profile, else RigSpec).
  const launchModel = nativeRequested ? profile?.effective.model ?? null : null;
  const costlyLaunch = isCostlyModel(launchModel, readCostlyPatterns());
  const [costConfirm, setCostConfirm] = useState(false);
  function requestStart() {
    if (costlyLaunch && !costConfirm) return setCostConfirm(true);
    setCostConfirm(false);
    void startSession();
  }

  async function startSession() {
    if (mutating || profileSaving || unresolvedOperationId || nativeBlocked) return;
    // One UUID per intentional launch. Never retry a timed-out/indeterminate POST.
    const operationId = randomUUID();
    setUnresolved(operationId);
    setMutating(true);
    setFeedback("");
    try {
      const method = window.desktopBridge?.startOpenRigManagedSession;
      if (!method) throw new Error("Managed session creation is not installed in T3.");
      const result = await method({
        seatId: agent.id,
        operationId,
        ...(launchKind ? { kind: launchKind } : {}),
        ...(launchKind !== "chatgpt" && launchRoot.trim() ? { workspaceRoot: launchRoot.trim() } : {}),
        ...(launchTitle.trim() ? { title: launchTitle.trim() } : {}),
        ...(launchPrompt.trim() ? { initialPrompt: launchPrompt.trim() } : {}),
        ...(launchParentSeatId.trim() ? { parentSeatId: launchParentSeatId.trim() } : {}),
        ...(launchParentManagedSessionId.trim() ? { parentManagedSessionId: launchParentManagedSessionId.trim() } : {}),
      });
      seat.setLedger(result);
      setUnresolved(null);
      const launched = result.sessions.find((session) => session.operationId === operationId);
      setFeedback(launched?.mode === "native"
        ? launched.status === "pending"
          ? "OpenRig persisted a native T3 thread and accepted its bootstrap/task prompt as one initial message. Exact environment/provider verification is pending; model completion is unverified. Do not relaunch."
          : "OpenRig persisted the exact-provider native T3 thread. Bootstrap and optional task prompt were accepted as ONE initial message (not sent again); model completion is unverified."
        : launched?.status === "pending"
          ? "ChatGPT spawn accepted OpenRig's bootstrap and optional task prompt. Waiting for a verified /c/ conversation URL; do not relaunch."
          : "OpenRig created a managed ChatGPT session with bootstrap; model completion is unverified.");
      await onChanged();
    } catch (error) {
      const reason = explanation(error);
      if (isPreIntentLaunchRejection(reason)) {
        // A native feature-gate 409 is expressly BEFORE any side effect, unlike
        // a 503/timeout. A future attempt uses a NEW operation UUID.
        setUnresolved(null);
        setFeedback("OpenRig rejected launch before creation (operation " + operationId + "): " + reason +
          ". For native T3, deploy exact-provider persisted create and enable OPENRIG_T3_NATIVE_CREATE_ENABLED=1; fix explicit seat runtime, provider instance, catalog model, runtime mode, environment and workspace as needed. No thread was created by this request.");
      } else {
        setFeedback("Launch outcome unconfirmed (operation " + operationId + "): " + reason +
          ". Inspect OpenRig's ledger and provider; do not retry or reuse this operation ID.");
      }
      seat.refresh();
    } finally {
      setMutating(false);
    }
  }

  async function mutate(run: () => Promise<DesktopOpenRigSeatSessions>, success: string, failure: string) {
    if (mutating) return;
    setMutating(true);
    setFeedback("");
    try {
      seat.setLedger(await run());
      setFeedback(success);
      await onChanged();
    } catch (error) {
      setFeedback(failure + explanation(error));
      seat.refresh();
    } finally {
      setMutating(false);
    }
  }
  const makePrimary = (sessionId: string) => mutate(async () => {
    const method = window.desktopBridge?.selectOpenRigPrimarySession;
    if (!method) throw new Error("Primary session selection is not installed in T3.");
    return method({ seatId: agent.id, sessionId });
  }, "OpenRig confirmed the new primary session.", "Primary selection unconfirmed: ");
  const reconcileChatGPT = (sessionId: string) => mutate(async () => {
    const method = window.desktopBridge?.reconcileOpenRigChatGPTManagedSession;
    if (!method) throw new Error("Managed ChatGPT reconciliation is unavailable.");
    return method({ seatId: agent.id, sessionId });
  }, "OpenRig confirmed this ChatGPT conversation URL.", "Conversation URL not reconciled (do not relaunch): ");
  const detachManaged = (sessionId: string) => {
    if (detachConfirmation !== sessionId) return;
    return mutate(async () => {
      const method = window.desktopBridge?.detachOpenRigManagedSession;
      if (!method) throw new Error("Managed detachment IPC unavailable.");
      const result = await method({ seatId: agent.id, sessionId });
      setDetachConfirmation(null);
      return result;
    }, "OpenRig detached session ownership. Provider history remains intact.", "Detachment unconfirmed: ");
  };

  async function managedBrowserLifecycle(
    sessionId: string, action: DesktopOpenRigManagedBrowserLifecycleInput["action"],
  ) {
    if (mutating || profileSaving || unresolvedOperationId || uncertainLifecycleSession === sessionId ||
        (action === "stop" && closeConfirmation !== sessionId)) return;
    const seatId = agent.id;
    const generation = lifecycleGeneration.current;
    setMutating(true);
    setLifecycleReceipt(null);
    setFeedback("");
    try {
      const method = window.desktopBridge?.runOpenRigManagedBrowserLifecycle;
      if (!method) throw new Error("Managed browser lifecycle IPC is not installed in T3.");
      const input: DesktopOpenRigManagedBrowserLifecycleInput = action === "stop"
        ? { seatId, sessionId, action, confirm: "close-local-t3-session" }
        : { seatId, sessionId, action };
      const receipt = await method(input);
      if (generation !== lifecycleGeneration.current || seatId !== agent.id) return;
      if (receipt.seatId !== seatId || receipt.managedSessionId !== sessionId || receipt.action !== action ||
          !receipt.providerAcknowledged || receipt.modelCompletionVerified !== false)
        throw new Error("Lifecycle receipt does not match the selected OpenRig managed session.");
      setLifecycleReceipt(receipt);
      setCloseConfirmation(null);
      const meaning = {
        suspend: "T3 confirmed local archive; no running model was paused or completed.",
        resume: "T3 confirmed archive restoration; browser reattaches on render.",
        recover: "T3 requested safe saved-URL navigation; page load is NOT verified.",
        stop: "T3 confirmed permanent LOCAL record close and OpenRig ledger detachment; cloud conversation remains.",
      }[action];
      setFeedback(meaning + " Model completion remains unverified.");
      seat.refresh();
      try { await onChanged(); } catch {
        setFeedback(meaning + " Model completion remains unverified. Agent overview refresh failed; the exact lifecycle receipt remains available.");
      }
    } catch (error) {
      if (generation !== lifecycleGeneration.current || seatId !== agent.id) return;
      const reason = explanation(error);
      setCloseConfirmation(null);
      setLifecycleReceipt(null);
      if (!/OpenRig bridge HTTP (400|404|409)(?:\b|:)/.test(reason)) setUncertainLifecycleSession(sessionId);
      setFeedback("Lifecycle operation refused or outcome unconfirmed: " + reason +
        " Inspect the exact T3 browser, OpenRig managed ledger and unsent drafts. Do not retry an uncertain action.");
      seat.refresh();
    } finally {
      // Keep the shared seat's mutation guard until the original POST settles,
      // even if the operator switches workspaces during that request.
      setMutating(false);
    }
  }

  async function adoptExisting() {
    if (mutating || unresolvedOperationId) return;
    const session = available.find((candidate) => candidate.id === chosen);
    if (!session || session.target.kind === "legacy-browser") return;
    const operationId = randomUUID();
    setUnresolved(operationId);
    setMutating(true);
    setFeedback("");
    try {
      const method = window.desktopBridge?.adoptOpenRigManagedSession;
      if (!method) throw new Error("Managed adoption IPC unavailable.");
      seat.setLedger(await method({ seatId: agent.id, operationId, target: session.target }));
      setUnresolved(null);
      setFeedback("OpenRig confirmed explicit adoption into its managed session ledger.");
      setAdvanced(false);
      await onChanged();
    } catch (error) {
      setFeedback("Adoption unconfirmed for " + operationId + ": " + explanation(error) + ". Check the ledger before another adoption.");
      seat.refresh();
    } finally {
      setMutating(false);
    }
  }

  if (!ledger)
    return seat.ledgerError ? (
      <div role="alert" className="space-y-2 text-xs">
        <p>Managed sessions unavailable: {seat.ledgerError}</p>
        <Button size="xs" variant="outline" onClick={seat.refresh}>Retry</Button>
      </div>
    ) : (
      <p role="status" className="text-xs text-muted-foreground">Loading OpenRig-owned sessions…</p>
    );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">OpenRig-owned sessions ({ledger.sessions.length})</h3>
        <div className="flex gap-1">
          <Button size="xs" variant="outline" disabled={seat.ledgerLoading} onClick={seat.refresh}>Refresh sessions</Button>
          <Button size="xs" disabled={mutating || profileSaving || Boolean(unresolvedOperationId) || nativeBlocked} onClick={requestStart}>
            {mutating ? "Working…" : hasManaged ? "New session" : "Start session"}
          </Button>
        </div>
      </div>
      {costConfirm && costlyLaunch && (
        <div role="alertdialog" aria-label="Confirm costly model launch" className="space-y-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-xs">
          <p>
            This launch will use <span className="font-semibold">{launchModel}</span>, which is flagged as costly on this device. T3 cannot
            show its price or enforce a budget. This local confirmation is not the OpenRig spawn approval. Start it anyway?
          </p>
          <div className="flex gap-1">
            <Button size="xs" variant="destructive-outline" onClick={requestStart}>Launch costly model</Button>
            <Button size="xs" variant="ghost-muted" onClick={() => setCostConfirm(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {feedback && <p role="status" className="rounded-lg bg-muted/40 px-3 py-2 text-xs">{feedback}</p>}
      {lifecycleReceipt && (
        <details className="rounded-lg border border-border p-2 text-2xs" aria-label="OpenRig confirmed T3 lifecycle receipt">
          <summary>Server receipt: {lifecycleReceipt.action} · {lifecycleReceipt.effect}</summary>
          <p>Seat {lifecycleReceipt.seatId} · managed {lifecycleReceipt.managedSessionId} · browser {lifecycleReceipt.browserSessionId}</p>
          <p>ChatGPT /c/{lifecycleReceipt.conversationId} · persisted managed state {lifecycleReceipt.managedStatus} · model completion unverified</p>
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(lifecycleReceipt.receipt, null, 2)}</pre>
        </details>
      )}
      {uncertainLifecycleSession && (
        <Notice tone="warning">Lifecycle outcome for {uncertainLifecycleSession} is uncertain. Further lifecycle controls for this session are disabled until the exact T3 browser and OpenRig ledger can be independently inspected. No automatic retry.</Notice>
      )}
      {!window.desktopBridge?.runOpenRigManagedBrowserLifecycle && ledger.sessions.some(session =>
        session.status === "active" && session.target?.kind === "chatgpt-conversation") && (
        <Notice>Managed browser lifecycle controls require a compatible T3 desktop build. No lifecycle action is available in this client.</Notice>
      )}
      {!hasManaged && (
        <p className="text-xs text-muted-foreground">
          No OpenRig-managed sessions yet. Start one through OpenRig. No existing T3 conversation will be assigned automatically.
        </p>
      )}
      {nativeBlocked && (
        <Notice>
          Native start disabled until OpenRig reports nativeLaunchReady. Configure the exact execution profile in Settings or deploy
          the compatible T3 native-create bridge. To launch an additional ChatGPT execution under this same seat, choose ChatGPT
          explicitly in Launch options.
        </Notice>
      )}
      {unresolvedOperationId && (
        <div role="alert" className="space-y-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-xs">
          <p>
            Launch outcome uncertain for operation {unresolvedOperationId}. Do not resubmit this operation. Inspect the ledger
            and exact provider/environment before requesting another. A pending or indeterminate native thread is not proof the
            model completed bootstrap.
          </p>
          <div className="flex flex-wrap gap-1">
            <Button size="xs" variant="outline" disabled={seat.ledgerLoading} onClick={seat.refresh}>Refresh ledger</Button>
            <Button size="xs" variant="ghost-muted" disabled={seat.ledgerLoading} onClick={() => setUnresolved(null)}>
              I inspected this operation; allow a separate launch
            </Button>
          </div>
        </div>
      )}
      <div className="rounded-xl border border-border">
        <Button size="xs" variant="ghost-muted" aria-expanded={showLaunchOptions} onClick={() => setShowLaunchOptions((value) => !value)}>
          {showLaunchOptions ? "Hide launch options" : "Launch options"}
        </Button>
        {showLaunchOptions && (
          <div className="grid gap-2 border-t border-border p-3 text-xs text-muted-foreground sm:grid-cols-2">
            <p className="sm:col-span-2">
              OpenRig uses the exact RigSpec driver and a saved operator-approved provider/model/workspace profile (or fully explicit
              RigSpec settings), never T3&apos;s selected/default provider or an open-workspace draft. Native requires an exact ready T3
              provider instance and model, runtime mode, root and environment. A compatible desktop and
              OPENRIG_T3_NATIVE_CREATE_ENABLED=1 are required. ChatGPT is an additional explicitly selectable execution mode for the
              same stable seat. OpenRig adds bootstrap for both runtimes and sends it once at launch.
            </p>
            <select aria-label={`Runtime for ${agent.name}`} className={inputClass} value={launchKind}
              onChange={(event) => setLaunchKind(event.currentTarget.value as "" | "native" | "chatgpt")}>
              <option value="">Use explicit seat-configured runtime (no fallback)</option>
              <option value="native">Native T3 (explicit)</option>
              <option value="chatgpt">ChatGPT (explicit)</option>
            </select>
            <input aria-label={`Workspace root for ${agent.name}`} value={launchRoot} className={inputClass}
              placeholder="Native workspace override (optional; must match profile)"
              disabled={launchKind === "chatgpt"} onChange={(event) => setLaunchRoot(event.currentTarget.value)} />
            <input aria-label={`Session title for ${agent.name}`} value={launchTitle} className={inputClass}
              placeholder="Session title (optional)" onChange={(event) => setLaunchTitle(event.currentTarget.value)} />
            <input aria-label={`Parent OpenRig seat for ${agent.name}`} value={launchParentSeatId} className={inputClass}
              placeholder="Parent seat ID (optional; RigSpec relation required)"
              onChange={(event) => setLaunchParentSeatId(event.currentTarget.value)} />
            <input aria-label={`Parent managed session for ${agent.name}`} value={launchParentManagedSessionId} className={inputClass}
              placeholder="Parent managed session ID (optional; requires parent seat)"
              onChange={(event) => setLaunchParentManagedSessionId(event.currentTarget.value)} />
            <div className="sm:col-span-2">
              <Textarea size="sm" rows={2} aria-label={`Launch prompt for ${agent.name}`}
                placeholder="Optional task prompt, sent once with OpenRig's bootstrap"
                value={launchPrompt} onChange={(event) => setLaunchPrompt(event.currentTarget.value)} />
            </div>
          </div>
        )}
      </div>
      <ul className="space-y-2" aria-label={`Managed sessions for ${agent.name}`}>
        {ledger.sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            isPrimary={ledger.primarySessionId === session.id}
            mutating={mutating}
            confirmingDetach={detachConfirmation === session.id}
            confirmingClose={closeConfirmation === session.id}
            lifecycleBlocked={!window.desktopBridge?.runOpenRigManagedBrowserLifecycle ||
              Boolean(unresolvedOperationId) || profileSaving || uncertainLifecycleSession === session.id}
            onLifecycle={(action) => void managedBrowserLifecycle(session.id, action)}
            onCloseRequest={() => { setCloseConfirmation(session.id); setDetachConfirmation(null); }}
            onCloseCancel={() => setCloseConfirmation(null)}
            onMakePrimary={() => void makePrimary(session.id)}
            onReconcile={() => void reconcileChatGPT(session.id)}
            onDetachRequest={() => setDetachConfirmation(session.id)}
            onDetachCancel={() => setDetachConfirmation(null)}
            onDetachConfirm={() => void detachManaged(session.id)}
          />
        ))}
      </ul>
      {Boolean(ledger.legacyBinding) && (
        <Notice>
          Legacy conversation still recorded: {agent.sessionTitle ?? agent.bindingKind ?? "unknown"}. It cannot receive seat messages;
          explicitly adopt a verified conversation into OpenRig&apos;s managed ledger if needed.
        </Notice>
      )}
      <div className="rounded-xl border border-dashed border-border">
        <Button size="xs" variant="ghost-muted" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>
          {advanced ? "Hide advanced" : "Advanced: adopt existing unmanaged conversation"}
        </Button>
        {advanced && (
          <div className="space-y-2 border-t border-dashed border-border p-3 text-xs">
            <p className="text-muted-foreground">
              Explicit adoption puts an exact native T3 or verified ChatGPT conversation under OpenRig ownership. Browser tab IDs are
              not durable provider identities.
            </p>
            <input aria-label={`Filter conversations for ${agent.name}`} type="search" className={inputClass}
              value={filter} placeholder="Filter existing conversations" onChange={(event) => setFilter(event.currentTarget.value)} />
            <select aria-label={`T3 session for ${agent.name}`} className={inputClass} value={chosen}
              onChange={(event) => setChosen(event.currentTarget.value)}>
              <option value="">Choose an unmanaged conversation</option>
              {available.filter((session) =>
                session.target.kind !== "legacy-browser" &&
                [session.title, session.id, session.project, session.provider]
                  .some((value) => value?.toLowerCase().includes(filter.toLowerCase())),
              ).map((session) => (
                <option key={session.id} value={session.id}>{session.title} · {session.kind}</option>
              ))}
            </select>
            <Button size="xs" variant="outline" disabled={mutating || !chosen || Boolean(unresolvedOperationId)} onClick={() => void adoptExisting()}>
              Adopt into OpenRig
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function SessionCard({
  session, isPrimary, mutating, confirmingDetach, confirmingClose, lifecycleBlocked,
  onLifecycle, onCloseRequest, onCloseCancel,
  onMakePrimary, onReconcile, onDetachRequest, onDetachCancel, onDetachConfirm,
}: {
  session: DesktopOpenRigManagedSession;
  isPrimary: boolean;
  mutating: boolean;
  confirmingDetach: boolean;
  confirmingClose: boolean;
  lifecycleBlocked: boolean;
  onLifecycle: (action: DesktopOpenRigManagedBrowserLifecycleInput["action"]) => void;
  onCloseRequest: () => void;
  onCloseCancel: () => void;
  onMakePrimary: () => void;
  onReconcile: () => void;
  onDetachRequest: () => void;
  onDetachCancel: () => void;
  onDetachConfirm: () => void;
}) {
  const href = historyHref(session.target);
  const observed = sessionObservedStatus(session);
  return (
    <li className={`rounded-xl border px-3 py-2.5 text-xs ${isPrimary ? "border-info/50 bg-info/5" : "border-border"}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium">{sessionDisplayTitle(session)}</span>
        {isPrimary && <Badge variant="info">Primary</Badge>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        <span>{sessionProviderLabel(session)}</span>
        <SessionModel session={session} />
        <span>{session.status}</span>
        {observed !== null && <span>Observed: {observed}</span>}
        <span>Created {formatTimestamp(session.createdAt)}</span>
        {session.lastActivityAt && <span>Last activity {formatTimestamp(session.lastActivityAt)}</span>}
        <span aria-label={`Operation ${session.operationId}`}>Operation {session.operationId.slice(0, 8)}</span>
        {session.parentSeatId && (
          <span>Spawned from seat {session.parentSeatId}{session.parentManagedSessionId ? ` / session ${session.parentManagedSessionId.slice(0, 12)}` : ""}</span>
        )}
      </div>
      {session.error && <p role="alert" className="mt-1 text-2xs text-destructive">{session.error}</p>}
      {session.mode === "native" && session.status === "pending" && (
        <p className="mt-1 text-2xs text-muted-foreground">Persisted create may await exact provider/environment observation. Do not relaunch.</p>
      )}
      {session.recoveryEvidence && (
        <p role="status" className="mt-1 text-2xs text-muted-foreground">
          Native recovery: {session.recoveryEvidence.exactEnvironmentAndProvider
            ? "Exact thread observed; reconciliation required" : "Exact thread not yet verified"}.
          Initial-message acknowledgment not verified; no automatic retry.
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {href && (
          <a
            className="rounded-md px-2 py-1 text-2xs font-medium text-info hover:bg-muted"
            href={href}
            rel={href.startsWith("https://") ? "noopener noreferrer" : undefined}
            target={href.startsWith("https://") ? "_blank" : undefined}
          >
            History
          </a>
        )}
        {!isPrimary && session.status === "active" && session.target && (
          <Button size="xs" variant="ghost-muted" disabled={mutating} onClick={onMakePrimary}>Make primary</Button>
        )}
        {session.mode === "chatgpt" && session.status === "pending" && session.attachedTabUuid && (
          <Button size="xs" variant="ghost-muted" disabled={mutating} onClick={onReconcile}>Reconcile URL</Button>
        )}
        {isPrimary && session.primary && (session.mode === "chatgpt" || session.mode === "adopt") &&
          session.status === "active" && session.target?.kind === "chatgpt-conversation" &&
          session.attachedTabUuid && session.conversationId === session.target.conversationId && (
          <>
            <Button size="xs" variant="ghost-muted" disabled={mutating || lifecycleBlocked} onClick={() => onLifecycle("suspend")}>
              Archive idle browser
            </Button>
            <Button size="xs" variant="ghost-muted" disabled={mutating || lifecycleBlocked} onClick={() => onLifecycle("resume")}>
              Restore archived browser
            </Button>
            <Button size="xs" variant="ghost-muted" disabled={mutating || lifecycleBlocked} onClick={() => onLifecycle("recover")}>
              Recover blank homepage
            </Button>
            {confirmingClose ? (
              <>
                <span className="text-destructive">Permanent LOCAL T3 record close; not cloud deletion, model/process stop, or task completion.</span>
                <Button size="xs" variant="ghost-destructive" disabled={mutating || lifecycleBlocked}
                  onClick={() => onLifecycle("stop")}>Confirm permanent local close</Button>
                <Button size="xs" variant="ghost-muted" disabled={mutating} onClick={onCloseCancel}>Cancel local close</Button>
              </>
            ) : (
              <Button size="xs" variant="ghost-destructive" disabled={mutating || lifecycleBlocked}
                onClick={onCloseRequest}>Close local T3 record…</Button>
            )}
          </>
        )}
        {session.status !== "detached" && (confirmingDetach ? (
          <>
            <Button size="xs" variant="ghost-destructive" disabled={mutating} onClick={onDetachConfirm}>Confirm detach</Button>
            <Button size="xs" variant="ghost-muted" disabled={mutating} onClick={onDetachCancel}>Cancel</Button>
          </>
        ) : (
          <Button size="xs" variant="ghost-muted" disabled={mutating} onClick={onDetachRequest}>Detach ownership</Button>
        ))}
      </div>
    </li>
  );
}

/** Model and effort T3 stored for the thread, else OpenRig's launch intent. Never guessed. */
function SessionModel({ session }: { session: DesktopOpenRigManagedSession }) {
  const target = session.target?.kind === "t3-thread" ? session.target : null;
  const environmentId = target?.environmentId ?? null;
  const threadId = target?.threadId ?? null;
  const ref = useMemo(
    () => (environmentId && threadId ? scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)) : null),
    [environmentId, threadId],
  );
  const shell = useThreadShell(ref);
  const intent = session.intent as { modelSelection?: { model?: unknown } } | null;
  const model = shell?.modelSelection.model ??
    (typeof intent?.modelSelection?.model === "string" ? intent.modelSelection.model : null);
  const effort = shell ? selectionEffort(shell.modelSelection.options) : null;
  const costly = isCostlyModel(model, readCostlyPatterns());
  return (
    <span className="inline-flex items-center gap-1">
      {model ?? (session.mode === "chatgpt" ? "ChatGPT model not recorded" : "model not recorded")}
      {effort && <span>· effort {effort}</span>}
      {costly && <Badge variant="warning" size="sm">Costly</Badge>}
    </span>
  );
}

function ActivityPanel({ agent, snapshotAt, ledger, sends, reports }: {
  agent: DesktopOpenRigAgent;
  snapshotAt: string | null;
  ledger: DesktopOpenRigSeatSessions | null;
  sends: readonly WorkspaceSend[];
  reports: readonly DesktopOpenRigSeatReport[] | null;
}) {
  const entries = buildActivity(agent, snapshotAt, ledger, sends, reports ?? []);
  return (
    <>
      <p className="text-2xs text-muted-foreground">
        Built only from OpenRig ledger timestamps, persisted seat reports (author unverified), the latest seat snapshot and
        messages sent from this workspace in this app session. Seat-to-seat messages are not exposed for reading yet.
      </p>
      {entries.length === 0 ? (
        <Unexposed>No recorded activity yet.</Unexposed>
      ) : (
        <ol aria-label={`Activity for ${agent.name}`} className="space-y-1.5 border-l border-border pl-3">
          {entries.map((entry) => (
            <li key={entry.key} className="text-xs">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{entry.title}</span>
                <time dateTime={entry.at} className="text-2xs text-muted-foreground">{formatTimestamp(entry.at)}</time>
                <span className="text-3xs text-muted-foreground">{entry.source}</span>
              </div>
              {entry.detail && <p className="break-words text-2xs text-muted-foreground">{entry.detail}</p>}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function MemoryPanel({ agent, profile }: { agent: DesktopOpenRigAgent; profile: DesktopOpenRigExecutionProfile | null }) {
  const rig = profile?.rigSpec;
  return (
    <>
      <Card title="Role">
        {agent.role ? <p>{agent.role.replaceAll("-", " ")}</p> : <Unexposed>No role declared for this seat.</Unexposed>}
      </Card>
      <Card title="RigSpec declaration">
        {!rig ? (
          <Unexposed>RigSpec execution settings are unavailable until the execution profile loads.</Unexposed>
        ) : (
          <>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
              <dt className="text-muted-foreground">Runtime</dt><dd>{rig.runtime ?? "not configured"}</dd>
              <dt className="text-muted-foreground">Working directory</dt><dd className="break-all">{rig.cwd ?? "not declared"}</dd>
              <dt className="text-muted-foreground">Workspace</dt><dd className="break-all">{rig.workspace ?? "not declared"}</dd>
              <dt className="text-muted-foreground">Model</dt><dd>{rig.model ?? "not declared"}</dd>
            </dl>
            <p className="mt-1.5 text-2xs text-muted-foreground">
              Informational. Native launches use only the explicit execution profile in Settings, never these declarations.
            </p>
          </>
        )}
      </Card>
      <Card title="Memory and instructions">
        <Unexposed>OpenRig does not yet expose seat memory or standing instructions to T3.</Unexposed>
      </Card>
    </>
  );
}

function SettingsPanel({ agent, seat }: { agent: DesktopOpenRigAgent; seat: Seat }) {
  const { profile, profileSaving, setProfileSaving, mutating } = seat;
  const [feedback, setFeedback] = useState("");
  const [root, setRoot] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("");
  const [environmentId, setEnvironmentId] = useState("");
  const touched = useRef(false);
  const saved = profile?.profile ?? null;

  // Only a previously saved explicit profile may prepopulate the form;
  // never infer values from RigSpec, the current editor or historical tabs.
  useEffect(() => {
    if (touched.current || !saved) return;
    setRoot(saved.workspaceRoot);
    setProviderId(saved.providerInstanceId);
    setModel(saved.model);
    setRuntimeMode(saved.runtimeMode);
    setEnvironmentId(saved.environmentId);
  }, [saved]);

  const isNativeSeat = profile?.rigSpec.runtime?.toLowerCase() === "codex" || profile?.rigSpec.runtime?.toLowerCase() === "claude";
  const valid = /^[A-Za-z]:\\/u.test(root.trim()) && root.trim().length <= 1024 && !/[\r\n\0]/u.test(root) &&
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(providerId.trim()) &&
    Boolean(model.trim()) && model.trim().length <= 256 && runtimeMode !== "" &&
    (!environmentId.trim() || environmentId.trim().length <= 256);
  const edit = (set: (value: string) => void) => (value: string) => { touched.current = true; set(value); };

  async function save() {
    if (profileSaving || mutating || !profile || !isNativeSeat || !valid) return;
    setProfileSaving(true);
    setFeedback("");
    try {
      const method = window.desktopBridge?.configureOpenRigExecutionProfile;
      if (!method) throw new Error("Execution profile configuration IPC is not installed. Deploy updated T3.");
      const result = await method({
        seatId: agent.id,
        workspaceRoot: root.trim(),
        providerInstanceId: providerId.trim(),
        model: model.trim(),
        runtimeMode,
        ...(environmentId.trim() ? { environmentId: environmentId.trim() } : {}),
      });
      seat.setProfile(result);
      seat.setProfileError("");
      touched.current = false;
      setEnvironmentId(result.profile?.environmentId ?? "");
      setFeedback(result.nativeLaunchReady
        ? "OpenRig saved this explicit provider-catalog profile. Native launch is ready. Existing sessions and primary remain unchanged."
        : "OpenRig saved this explicit provider-catalog profile, but native launch remains gated. Deploy exact-provider T3 create and enable OPENRIG_T3_NATIVE_CREATE_ENABLED=1, then refresh readiness. Existing sessions were not changed.");
    } catch (error) {
      setFeedback("Profile not confirmed: " + explanation(error) +
        ". HTTP 409 means the seat runtime, T3 provider instance/model, environment or deployment is not ready; verify the live catalog and refresh the saved profile before resubmitting. Nothing was inferred or adopted.");
      seat.refresh();
    } finally {
      setProfileSaving(false);
    }
  }

  if (seat.profileLoading && !profile)
    return <p role="status" className="text-xs text-muted-foreground">Checking native execution readiness…</p>;
  if (!profile)
    return (
      <div role="alert" className="space-y-2 text-xs">
        <p>Execution profile unavailable: {seat.profileError}. ChatGPT sessions can still be launched explicitly.</p>
        <Button size="xs" variant="outline" onClick={seat.refresh}>Retry profile check</Button>
      </div>
    );

  return (
    <>
      <section aria-label={`Native execution readiness for ${agent.name}`} className="space-y-1.5 rounded-xl border border-border px-3 py-2.5 text-xs">
        <div className="flex items-center gap-2">
          <span className={`size-2 rounded-full ${profile.nativeLaunchReady ? "bg-success" : "bg-warning"}`} aria-hidden />
          <span className="font-semibold">Native execution: {profile.nativeLaunchReady ? "Ready" : "Not ready"}</span>
        </div>
        <p className="text-muted-foreground">
          Seat runtime: {profile.rigSpec.runtime ?? "not configured"}.
          {saved
            ? ` Explicit operator profile: ${saved.providerInstanceId} / ${saved.model} in ${saved.environmentId}.`
            : " No saved operator profile. Exact provider, model and workspace must be explicitly approved; never inferred from old conversations or the current T3 editor."}
        </p>
        {!profile.nativeLaunchReady && (
          <p role="alert" className="text-muted-foreground">
            {profile.missing.length > 0
              ? `Missing native settings: ${profile.missing.join(", ")}. Configure the exact provider catalog profile once before native launch. `
              : "Profile settings are present, but native launch is still gated. "}
            A native 409 means no launch was accepted: deploy exact-provider T3 create and enable OPENRIG_T3_NATIVE_CREATE_ENABLED=1, or
            resolve the reported configuration/catalog failure. Explicit ChatGPT sessions remain available.
          </p>
        )}
      </section>
      <section aria-label={`Execution profile for ${agent.name}`} className="space-y-2 rounded-xl border border-border px-3 py-2.5 text-xs">
        <h3 className="font-semibold">{saved ? "Edit explicit execution profile" : "Configure explicit execution profile"}</h3>
        <p className="text-muted-foreground">
          Enter the actual existing Windows workspace and the EXACT ready provider instance ID and model slug from T3&apos;s live
          provider catalog. OpenRig validates instance, driver, catalog model and environment. This additive profile does not
          overwrite RigSpec, adopt old sessions or change the primary. Saving does not launch a session.
        </p>
        {!isNativeSeat && (
          <p role="alert" className="text-warning">
            This RigSpec seat must declare runtime codex or claude before native configuration; T3 cannot silently choose a driver.
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <input aria-label={`Native profile workspace for ${agent.name}`} value={root} maxLength={1024} className={inputClass}
            placeholder="D:\\ExistingProject (required)" onChange={(event) => edit(setRoot)(event.currentTarget.value)} />
          <input aria-label={`Native profile provider instance for ${agent.name}`} value={providerId} maxLength={64} className={inputClass}
            placeholder="Exact T3 providerInstanceId (required)" onChange={(event) => edit(setProviderId)(event.currentTarget.value)} />
          <input aria-label={`Native profile model for ${agent.name}`} value={model} maxLength={256} className={inputClass}
            placeholder="Exact model slug (required)" onChange={(event) => edit(setModel)(event.currentTarget.value)} />
          <select aria-label={`Native profile runtime mode for ${agent.name}`} value={runtimeMode} className={inputClass}
            onChange={(event) => { touched.current = true; setRuntimeMode(event.currentTarget.value as RuntimeMode); }}>
            <option value="">Select exact approval/runtime mode (required)</option>
            <option value="approval-required">Approval required</option>
            <option value="auto-accept-edits">Auto-accept edits</option>
            <option value="auto">Auto</option>
            <option value="full-access">Full access</option>
          </select>
          <input aria-label={`Native profile environment for ${agent.name}`} value={environmentId} maxLength={256}
            className={`${inputClass} sm:col-span-2`} placeholder="Exact environment ID (optional; verified by OpenRig)"
            onChange={(event) => edit(setEnvironmentId)(event.currentTarget.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" disabled={profileSaving || mutating || !isNativeSeat || !valid} onClick={() => void save()}>
            {profileSaving ? "Validating with OpenRig…" : "Save explicit execution profile"}
          </Button>
          <Button size="xs" variant="ghost-muted" disabled={seat.profileLoading} onClick={seat.refresh}>Refresh readiness</Button>
        </div>
        {feedback && <p role="status" className="text-muted-foreground">{feedback}</p>}
      </section>
    </>
  );
}
