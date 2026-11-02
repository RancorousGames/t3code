import { useNavigate } from "@tanstack/react-router";
import type { ChatGPTRegistrySession, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

interface DashboardLiveTask {
  taskId: string;
  claimedBy: string;
  liveState: "ready" | "in_session" | null;
  boardRoot?: string;
  project?: string;
  withMe?: boolean;
  laterUntil?: string;
  taskTitle?: string;
  liveBrief?: string;
  liveEstMinutes?: number;
  liveReadyAt?: string;
}
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { ArchiveIcon, Clock3Icon, SearchIcon } from "lucide-react";

import { findExistingChatGPTConversation, chatGPTBrowserLastUrlKey, useChatGPTBrowserSessions } from "../chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "../chatGPTConversationIdentity";
import { registryBrowserSession, registryPageSnapshot } from "../chatGPTRegistryProjection";
import { readChatGPTRegistry } from "../state/chatGPTSessionRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { getChatGPTSessionPersistedStore } from "../chatGPTSessionPersistedStore";
import {
  CHATGPT_DASHBOARD_BUCKETS,
  groupChatGPTDashboardSessions,
  projectChatGPTDashboardSession,
  type ChatGPTDashboardSession,
} from "../chatGPTDashboardData";
import { hasUncertainChatGPTSend } from "../chatGPTSessionControl";
import {
  primaryChatGPTSessionAction,
  runChatGPTSessionAction,
} from "../chatGPTSessionActions";
import {
  manuallyRetryRecovery,
  readRecoveryQueue,
} from "./sidebar/chatGPTRecoveryQueue";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { ChatGPTSessionSearchPanel, type ChatGPTSessionSearchHit } from "./ChatGPTSessionSearchPanel";
import { readChatGPTRecoverySettings } from "../chatGPTRecoverySettings";

function relativeTime(at: number, now: number): string {
  if (!at) return "Never observed";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}

function estimatedRendererHeap(): string {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const used = memory?.usedJSHeapSize;
  return typeof used === "number" && used > 0
    ? `Renderer heap ~${Math.round(used / 1024 / 1024)} MB (excludes guest browsers)`
    : "Guest browser memory not measured";
}

export function ChatGPTSessionsDashboard({ environmentId }: { environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const store = useMemo(() => getChatGPTSessionPersistedStore(environmentId), [environmentId]);
  const snapshots = useStore(store, (state) => state.snapshots);
  const timeline = useStore(store, (state) => state.timeline);
  const { sessions, createSession, setSessionHidden, setSessionSnooze, setSessionCompletion, setSessionArchived } =
    useChatGPTBrowserSessions(environmentId);
  const [now, setNow] = useState(Date.now);
  const readRegistry = useAtomCommand(readChatGPTRegistry, { reportFailure: false });
  const [serverSessions, setServerSessions] = useState<readonly ChatGPTRegistrySession[] | null>(null);
  useEffect(() => {
    let disposed = false;
    let reading = false;
    const refresh = async () => {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const result = await readRegistry({ environmentId, input: { environmentId } });
        if (!disposed && result._tag === "Success") setServerSessions(result.value.sessions);
      } finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    window.addEventListener("focus", refresh);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [environmentId, readRegistry]);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const [query, setQuery] = useState(() => window.sessionStorage.getItem("t3code:chatgpt:dashboard-search:v1") ?? "");
  const [messageSearchOpen, setMessageSearchOpen] = useState(() => window.sessionStorage.getItem("t3code:chatgpt:dashboard-search:v1") !== null);
  useEffect(() => window.sessionStorage.removeItem("t3code:chatgpt:dashboard-search:v1"), []);
  const [managersOnly, setManagersOnly] = useState(false);
  const [projectFilter, setProjectFilter] = useState("all");
  const [expandedBuckets, setExpandedBuckets] = useState<Record<string, boolean>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [liveTasks, setLiveTasks] = useState<readonly DashboardLiveTask[]>([]);
  const [liveRefreshKey, setLiveRefreshKey] = useState(0);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  useEffect(() => {
    const read = window.desktopBridge?.readTaskBoardWorkerClaims;
    if (!read) return;
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const claims = await read();
        if (!disposed) setLiveTasks(claims.filter((claim) =>
          claim.withMe || claim.liveState === "ready" || claim.liveState === "in_session"));
      } catch {
        // Do not replace the last-known queue with a fictitious empty task list.
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("focus", refresh);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [liveRefreshKey]);

  useEffect(() => {
    const refresh = () => {
      setRecoveryVersion((value) => value + 1);
      setNow(Date.now());
    };
    window.addEventListener("chatgpt-recovery-queue-updated", refresh);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.removeEventListener("chatgpt-recovery-queue-updated", refresh);
      window.clearInterval(timer);
    };
  }, []);

  const recovery = useMemo(() => readRecoveryQueue(environmentId), [environmentId, recoveryVersion]);
  const registryRecords = useMemo(() => new Map((serverSessions ?? []).map((row) => [row.sessionId, row])), [serverSessions]);
  const projectedSessions = useMemo(() => {
    if (!serverSessions?.length) return sessions;
    const fromServer = serverSessions.flatMap((row) => {
      if (row.closedAt !== null) return [];
      const entry = registryBrowserSession(row);
      return entry ? [entry] : [];
    });
    // Keep locally-created sessions visible until the desktop driver uploads them.
    const known = new Set(fromServer.map((session) => session.id));
    return [...fromServer, ...sessions.filter((session) => !known.has(session.id))];
  }, [serverSessions, sessions]);
  const rows = useMemo(() => projectedSessions.map((session) => {
    const saved = recovery.failures[session.id];
    const serverSnapshot = registryPageSnapshot(registryRecords.get(session.id)?.snapshot ?? null);
    return projectChatGPTDashboardSession({
      session,
      snapshot: snapshots[session.id] ?? serverSnapshot,
      now,
      uncertainSend: hasUncertainChatGPTSend(environmentId, session.id),
      lastWorkingAt: timeline[session.id]?.active ?? registryRecords.get(session.id)?.timeline?.active ?? 0,
      ...(saved ? { recovery: {
        attempts: saved.attempts ?? 0,
        lastAttemptAt: saved.lastAttemptAt ?? null,
        lastOutcome: saved.lastOutcome ?? null,
        stoppedReason: saved.exhausted ? saved.reason : null,
      } } : {}),
    });
  }), [projectedSessions, snapshots, timeline, registryRecords, recovery, environmentId, now]);

  const search = query.trim().toLocaleLowerCase();
  const projects = useMemo(() => [...new Set(rows.map((row) => row.session.project).filter(
    (name): name is string => typeof name === "string" && name.length > 0,
  ))].sort((a, b) => a.localeCompare(b)), [rows]);
  const matches = useMemo(() => rows.filter((row) =>
    (!managersOnly || row.session.binding?.role === "manager") &&
    (projectFilter === "all" || row.session.project === projectFilter) &&
    (!search || [row.session.title, row.session.id, row.session.project ?? "",
      row.session.binding?.taskRef?.id ?? "", row.snapshot?.conversationId ?? "",
      row.snapshot?.lastAssistant?.text ?? "", row.model.statusLine]
      .some((field) => field.toLocaleLowerCase().includes(search)))
  ), [rows, search, managersOnly, projectFilter]);
  const groups = useMemo(() => groupChatGPTDashboardSessions(matches, now), [matches, now]);
  const orderedRows = useMemo(() => CHATGPT_DASHBOARD_BUCKETS.flatMap(([bucket]) => groups[bucket]),
    [groups]);
  const current = orderedRows.find((row) => row.session.id === selectedId) ?? orderedRows[0] ?? null;
  const recoveryCount = Object.keys(recovery.failures).length;
  const maintenancePaused = readChatGPTRecoverySettings().paused;

  const openSession = async (sessionId: string) => {
    await navigate({ to: "/browser/$browserSessionId", params: { browserSessionId: sessionId } });
  };
  const chooseSearchResult = async (hit: ChatGPTSessionSearchHit) => {
    const owner = sessions.find((candidate) => candidate.id === hit.sessionId) ??
      (hit.url ? findExistingChatGPTConversation(sessions, hit.url, (id) =>
        getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, id), Schema.String)) : undefined);
    if (!owner) {
      const serverOwner = projectedSessions.find((candidate) => candidate.id === hit.sessionId) ??
        (hit.url ? findExistingChatGPTConversation(projectedSessions, hit.url, (id) =>
          getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, id), Schema.String)) : undefined);
      if (serverOwner)
        throw new Error("This indexed conversation still has a server-registered T3 session, but its local guest is unavailable. Reconcile that session before reopening; no duplicate was created.");
      const conversationId = chatGPTConversationIdFromUrl(hit.url);
      if (!conversationId)
        throw new Error("Indexed conversation has no verified canonical URL; no session opened.");
      const sessionId = createSession(hit.title ?? "Saved conversation", {
        initialConversationUrl: `https://chatgpt.com/c/${conversationId}`,
        ...(hit.project ? { project: hit.project } : {}),
        explicitlyUserCreated: true,
      });
      if (hit.snippet)
        window.sessionStorage.setItem("t3code:chatgpt:session-match:v1", JSON.stringify({ ...hit, sessionId }));
      setMessageSearchOpen(false);
      await openSession(sessionId);
      return;
    }
    if (owner.hidden) setSessionHidden(owner.id, false);
    if ((owner.snoozedUntil ?? 0) > Date.now()) setSessionSnooze([owner.id], null);
    if (hit.snippet)
      window.sessionStorage.setItem("t3code:chatgpt:session-match:v1", JSON.stringify({ ...hit, sessionId: owner.id }));
    setMessageSearchOpen(false);
    await openSession(owner.id);
  };
  const snooze = (row: ChatGPTDashboardSession) => {
    if (row.model.activity === "working" || row.model.attention === "unconfirmed_send") {
      setFeedback("Working and unconfirmed-send sessions cannot be snoozed from the dashboard.");
      return;
    }
    setSessionSnooze([row.session.id], Date.now() + 60 * 60_000);
    setFeedback(`Snoozed ${row.session.title} for one hour.`);
  };
  const complete = (row: ChatGPTDashboardSession) => {
    const snapshot = row.snapshot;
    if (!snapshot || snapshot.activity !== "idle" || row.model.activity !== "idle" ||
      !snapshot.signals.composerPresent || snapshot.signals.stopButton ||
      snapshot.signals.draftPresent || !snapshot.lastAssistant?.text ||
      row.model.attention !== "none" || row.session.hidden ||
      Date.now() - snapshot.observedAt > 2 * 60_000) {
      setFeedback("Completion needs a recent, readable, idle conversation with no draft or pending delivery. Open the session to inspect it.");
      return;
    }
    setSessionCompletion(row.session.id, {
      declaredAt: new Date().toISOString(),
      observedTurns: snapshot.turnCount,
      observedUrl: snapshot.url,
    });
    setFeedback(`Marked ${row.session.title} complete. This remains bound to the observed conversation.`);
  };
  const doPrimary = async (row: ChatGPTDashboardSession) => {
    const context = { model: row.model, hasConversationUrl: !!row.snapshot?.url };
    const action = primaryChatGPTSessionAction(context);
    if (!action) return;
    try {
      const receipt = await runChatGPTSessionAction(action.id, row.session.id, context, async (id, sessionId) => {
        if (id === "unsnooze") {
          setSessionSnooze([sessionId], null);
        } else if (id === "retry_recovery") {
          if (!recovery.failures[sessionId]) return {
            ok: false, message: "No active recovery episode. Open Browser to inspect this session.",
          };
          manuallyRetryRecovery(environmentId, sessionId);
        } else if (id === "archive") {
          if (!row.snapshot?.url || row.model.activity !== "idle" ||
              row.model.attention !== "none") return {
            ok: false, message: "Archive requires a verified idle conversation. Open Browser and refresh its state.",
          };
          setSessionArchived(sessionId, {
            archivedAt: new Date().toISOString(),
            basis: "completion",
            conversationUrl: row.snapshot.url,
          });
        } else if (id === "open" || id === "answer" || id === "check_delivery" ||
                   id === "open_browser") {
          // Opening is explicit and is the only action here that can mount a guest.
          await openSession(sessionId);
        } else {
          return { ok: false, message: "This dashboard action is unavailable." };
        }
        return { ok: true };
      });
      if (!receipt.ok) setFeedback(receipt.message ?? "Action unavailable.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    }
  };

  const visibleLiveTasks = useMemo(() => liveTasks.filter((task) => {
    if (task.laterUntil && Date.parse(task.laterUntil) > now) return false;
    return task.liveState !== null || task.withMe;
  }), [liveTasks, now]);
  const readyLiveTasks = useMemo(() => visibleLiveTasks.filter((task) =>
    task.liveState === "ready").sort((a, b) =>
    Date.parse(a.liveReadyAt ?? "") - Date.parse(b.liveReadyAt ?? "") || a.taskId.localeCompare(b.taskId)),
  [visibleLiveTasks]);
  const activeLiveTasks = visibleLiveTasks.filter((task) => task.liveState === "in_session");
  const unpreppedLiveTasks = visibleLiveTasks.filter((task) => task.withMe && !task.liveState);

  const startLiveTask = async (task: DashboardLiveTask) => {
    if (!task.boardRoot || !window.desktopBridge?.openTaskBoardLiveSession || busyTaskId) {
      setFeedback("Opening live tasks requires the connected T3 desktop and a registered TaskBoard.");
      return;
    }
    setBusyTaskId(task.taskId);
    try {
      const receipt = await window.desktopBridge.openTaskBoardLiveSession({
        boardRoot: task.boardRoot, taskId: task.taskId, environmentId,
      });
      if (receipt.status === "unknown" || receipt.status === "in_progress" ||
        receipt.status === "prompt_unknown") {
        setFeedback(receipt.message ?? "Session opening is pending or unconfirmed; inspect the task before retrying.");
      } else if (receipt.sessionId) {
        await openSession(receipt.sessionId);
      } else if (receipt.threadId) {
        setFeedback("Native task thread focused in T3.");
      } else {
        setFeedback("No confirmed session focus. Inspect the task before retrying.");
      }
      setLiveRefreshKey((value) => value + 1);
    } catch (cause) {
      setFeedback("Open task: " + String(cause) + " Check its existing session before trying again.");
    } finally {
      setBusyTaskId(null);
    }
  };
  const controlLiveTask = async (task: DashboardLiveTask, action: "later" | "clear", minutes = 60) => {
    if (!task.boardRoot || !window.desktopBridge?.controlTaskBoardLiveSession || busyTaskId) {
      setFeedback("Changing live tasks requires the connected T3 desktop.");
      return;
    }
    setBusyTaskId(task.taskId);
    try {
      await window.desktopBridge.controlTaskBoardLiveSession({
        boardRoot: task.boardRoot, taskId: task.taskId, action,
        ...(action === "later" ? { until: new Date(Date.now() + minutes * 60_000).toISOString() } : {}),
      });
      setLiveRefreshKey((value) => value + 1);
    } catch (cause) {
      setFeedback("Could not update TaskBoard: " + String(cause));
    } finally {
      setBusyTaskId(null);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setMessageSearchOpen(true);
        return;
      }
      if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey ||
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)))
        return;
      const key = event.key.toLowerCase();
      if (!["j", "k", "enter", "s", "c"].includes(key) || orderedRows.length === 0) return;
      const index = Math.max(0, orderedRows.findIndex((row) => row.session.id === current?.session.id));
      if (key === "j" || key === "k") {
        const next = (index + (key === "j" ? 1 : -1) + orderedRows.length) % orderedRows.length;
        const nextRow = orderedRows[next]!;
        const id = nextRow.session.id;
        setSelectedId(id);
        const bucket = nextRow.model.bucket;
        if (bucket && groups[bucket].findIndex((row) => row.session.id === id) >= 5) {
          setExpandedBuckets((previous) => ({ ...previous, [bucket]: true }));
        }
        window.requestAnimationFrame(() =>
          document.querySelector(`[data-chatgpt-dashboard-id="${id}"]`)?.scrollIntoView({ block: "nearest" }),
        );
      } else if (current) {
        if (key === "enter") void openSession(current.session.id);
        if (key === "s") snooze(current);
        if (key === "c") complete(current);
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [orderedRows, current]);

  const summary = [
    ["needs_you", "Needs you", "bg-red-500"],
    ["working", "Working", "bg-emerald-500"],
    ["recently_stopped", "Recently stopped", "bg-sky-500"],
    ["idle", "Idle", "bg-zinc-500"],
    ["snoozed", "Snoozed", "bg-violet-500"],
    ["completed", "Completed today", "bg-emerald-300"],
  ] as const;
  type DashboardBucket = (typeof summary)[number][0];
  const visibleRows = (bucket: DashboardBucket, limit = 6) =>
    expandedBuckets[bucket] ? groups[bucket] : groups[bucket].slice(0, limit);
  const showMore = (bucket: DashboardBucket, limit = 6) => groups[bucket].length > limit && (
    <button type="button" className="w-full rounded-md border border-dashed border-border/70 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground"
      onClick={() => setExpandedBuckets((current) => ({ ...current, [bucket]: !current[bucket] }))}>
      {expandedBuckets[bucket] ? "Show fewer" : "+ " + (groups[bucket].length - limit) + " more"}
    </button>
  );
  const accentFor = (row: ChatGPTDashboardSession): string => {
    if (row.model.attention === "error" || row.model.attention === "recovery_stopped" ||
      row.model.attention === "conversation_full") return "border-l-red-500";
    if (row.model.attention === "unconfirmed_send" || row.model.activity === "interrupted")
      return "border-l-amber-500";
    if (row.model.attention === "question") return "border-l-sky-500";
    if (row.model.bucket === "working") return "border-l-emerald-500";
    if (row.model.bucket === "recently_stopped") return "border-l-sky-500";
    return "border-l-border";
  };
  const secondary = (bucket: DashboardBucket, title: string) => (
    <section aria-label={title} className="min-w-0 rounded-lg border border-border bg-card/30 p-3">
      <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title} <span className="rounded-full bg-muted px-2 py-0.5 font-normal text-foreground">{groups[bucket].length}</span>
      </h2>
      {groups[bucket].length === 0 && <p className="py-3 text-xs text-muted-foreground">No sessions</p>}
      <div className="divide-y divide-border/60">
        {visibleRows(bucket).map((row, index, array) => {
          const ctx = { model: row.model, hasConversationUrl: !!row.snapshot?.url };
          const primary = primaryChatGPTSessionAction(ctx);
          const project = row.session.project || "Other";
          return <div key={row.session.id} data-chatgpt-dashboard-id={row.session.id}>
            {(bucket === "idle" && (index === 0 ||
              (array[index - 1]?.session.project || "Other") !== project)) &&
              <div className="pt-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{project}</div>}
            <div className={"flex min-w-0 items-center gap-2 rounded-md px-1 py-1.5 text-xs " +
                (current?.session.id === row.session.id ? "bg-accent/20" : "hover:bg-muted/20")}>
              <button type="button" onClick={() => void openSession(row.session.id)} className="min-w-0 flex-1 truncate text-left font-medium hover:underline" title={row.session.title}>
                {row.session.title}
              </button>
              <span className="shrink-0 text-2xs text-muted-foreground">{relativeTime(row.updatedAt, now)} · {row.model.residency}</span>
              {primary && <Button size="xs" variant="ghost" onClick={() => void doPrimary(row)}>{primary.label(ctx)}</Button>}
              {bucket === "idle" && <Button size="xs" variant="ghost" onClick={() => snooze(row)}>Snooze</Button>}
            </div>
          </div>;
        })}
      </div>
      <div className="mt-2">{showMore(bucket)}</div>
    </section>
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 lg:p-4" aria-label="ChatGPT sessions dashboard">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">ChatGPT sessions</h1>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <div className="relative min-w-44 flex-1 sm:max-w-sm">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
            <Input aria-label="Search ChatGPT dashboard sessions" placeholder="Search titles and last replies…"
              className="h-8 pl-8 text-xs" value={query} onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setMessageSearchOpen(true); } }} />
          </div>
          <Button size="xs" variant="outline" onClick={() => setMessageSearchOpen((open) => !open)}>
            Search messages
          </Button>
          <select aria-label="Filter dashboard project" value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            className="h-8 max-w-40 rounded-md border border-border bg-card px-2 text-xs text-foreground">
            <option value="all">All projects</option>
            {projects.map((project) => <option value={project} key={project}>{project}</option>)}
          </select>
          <label className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={managersOnly} onChange={(event) => setManagersOnly(event.target.checked)} />
            Managers only
          </label>
        </div>
      </header>
      {messageSearchOpen && <ChatGPTSessionSearchPanel environmentId={environmentId} sessions={projectedSessions}
        initialQuery={query} onClose={() => setMessageSearchOpen(false)} onChoose={chooseSearchResult} />}
      {visibleLiveTasks.length > 0 && (
        <section aria-label="Ready to work with you" className="rounded-lg border border-emerald-800/60 bg-emerald-950/20 p-3">
          <header className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-emerald-300">Ready to work with you</h2>
            <span className="rounded-full bg-emerald-800/40 px-2 py-0.5 text-xs">{readyLiveTasks.length}</span>
            <span className="text-xs text-muted-foreground">Prepared tasks waiting for a live discussion</span>
            {readyLiveTasks[0] && (
              <Button className="ml-auto" size="xs" variant="secondary" disabled={busyTaskId !== null}
                onClick={() => void startLiveTask(readyLiveTasks[0]!)}>Start next</Button>
            )}
          </header>
          {readyLiveTasks.length > 0 && <div className="grid gap-2 md:grid-cols-2">
            {readyLiveTasks.slice(0, 4).map((task) => (
              <article key={task.taskId} className="rounded-lg border border-l-[3px] border-l-emerald-500 border-border bg-card/75 p-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <strong className="min-w-0 flex-1 truncate text-xs">{task.taskId} · {task.taskTitle ?? "Live task"}</strong>
                  {task.project && <span className="rounded border border-border px-1.5 text-2xs text-muted-foreground">{task.project}</span>}
                </div>
                {task.liveBrief && <p className="mt-1 line-clamp-2 text-xs text-foreground/85">{task.liveBrief}</p>}
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                  {task.liveEstMinutes && <span>~{task.liveEstMinutes} min</span>}
                  {task.liveReadyAt && Number.isFinite(Date.parse(task.liveReadyAt)) &&
                    <span>Ready {relativeTime(Date.parse(task.liveReadyAt), now)}</span>}
                  <span>{task.claimedBy ? "Session linked" : "Start new session"}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Button size="xs" variant="secondary" disabled={busyTaskId !== null}
                    onClick={() => void startLiveTask(task)}>{busyTaskId === task.taskId ? "Opening…" : "Start"}</Button>
                  <select aria-label={"Later: " + task.taskId} defaultValue="" disabled={busyTaskId !== null}
                    className="h-7 rounded-md border border-border bg-background px-1.5 text-xs"
                    onChange={(event) => {
                      const minutes = Number(event.currentTarget.value);
                      if (minutes > 0) void controlLiveTask(task, "later", minutes);
                      event.currentTarget.value = "";
                    }}>
                    <option value="" disabled>Later…</option>
                    <option value="60">1 hour</option>
                    <option value="360">6 hours</option>
                    <option value="1440">Tomorrow</option>
                  </select>
                  <Button size="xs" variant="ghost" disabled={busyTaskId !== null}
                    onClick={() => void controlLiveTask(task, "clear")}>Not needed</Button>
                </div>
              </article>
            ))}
          </div>}
          {readyLiveTasks.length > 4 && (
            <p className="mt-2 text-xs text-muted-foreground">{readyLiveTasks.length - 4} additional ready tasks; start one to free space.</p>
          )}
          {(activeLiveTasks.length > 0 || unpreppedLiveTasks.length > 0) && (
            <div className="mt-2 divide-y divide-border/60 border-t border-border/60">
              {activeLiveTasks.map((task) => (
                <div key={task.taskId} className="flex items-center gap-2 py-1.5 text-xs">
                  <span className="size-2 shrink-0 rounded-full bg-sky-500" />
                  <span className="min-w-0 flex-1 truncate">{task.taskId} · {task.taskTitle ?? "Live task"} <span className="text-muted-foreground">· with you, in progress</span></span>
                  <Button size="xs" variant="ghost" disabled={busyTaskId !== null}
                    onClick={() => void startLiveTask(task)}>Resume</Button>
                </div>
              ))}
              {unpreppedLiveTasks.map((task) => (
                <div key={task.taskId} className="flex items-center gap-2 py-1.5 text-xs">
                  <span className="shrink-0 text-muted-foreground">Not prepped yet</span>
                  <span className="min-w-0 flex-1 truncate">{task.taskId} · {task.taskTitle ?? "Live task"}</span>
                  <Button size="xs" variant="ghost" disabled={busyTaskId !== null}
                    onClick={() => void startLiveTask(task)}>Start with me</Button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <div className="flex flex-wrap gap-1.5" aria-label="Session counts">
        {summary.map(([bucket, title, color]) => (
          <button type="button" key={bucket}
            onClick={() => document.getElementById("chatgpt-dashboard-" + bucket)?.scrollIntoView({ block: "nearest", behavior: "smooth" })}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card/70 px-2.5 py-1.5 text-xs transition-colors hover:bg-accent/40">
            <span aria-hidden className={"size-2 rounded-full " + color} />
            <strong className="text-sm tabular-nums">{groups[bucket].length}</strong>
            <span className="text-muted-foreground">{title}</span>
          </button>
        ))}
      </div>
      {feedback && <div role="status" className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs">
        <span>{feedback}</span><Button size="xs" variant="ghost" onClick={() => setFeedback(null)}>Dismiss</Button>
      </div>}
      <div className="grid min-w-0 grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-[1.25fr_1fr_1fr]">
        {CHATGPT_DASHBOARD_BUCKETS.slice(0, 3).map(([bucket, title]) => (
          <section key={bucket} id={"chatgpt-dashboard-" + bucket} aria-label={title}
            className={"min-w-0 " + (bucket === "needs_you" ? "md:col-span-2 xl:col-span-1" : "")}>
            <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {title}<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-foreground">{groups[bucket].length}</span>
            </h2>
            <div className="space-y-2">
              {groups[bucket].length === 0 && <p className="rounded-lg border border-border/60 bg-card/30 px-3 py-6 text-center text-xs text-muted-foreground">No sessions</p>}
              {visibleRows(bucket).map((row) => {
                const ctx = { model: row.model, hasConversationUrl: !!row.snapshot?.url };
                const primary = primaryChatGPTSessionAction(ctx);
                const excerpt = row.snapshot?.lastAssistant?.text;
                return <article key={row.session.id} data-chatgpt-dashboard-id={row.session.id}
                  className={"rounded-lg border border-l-[3px] bg-card/70 px-3 py-2.5 transition-colors hover:bg-card " +
                    accentFor(row) + (current?.session.id === row.session.id ? " border-primary/70" : " border-border")}>
                  <div className="flex min-w-0 items-center gap-2">
                    <button type="button" onClick={() => void openSession(row.session.id)}
                      title={row.session.title} className="min-w-0 flex-1 truncate text-left text-xs font-semibold hover:underline">
                      {row.session.title}
                    </button>
                    {row.session.project && <span className="max-w-24 shrink-0 truncate rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground">{row.session.project}</span>}
                  </div>
                  <p className="mt-1.5 text-xs text-foreground/85">{row.model.statusLine}</p>
                  {excerpt && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{excerpt}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
                    <span>{relativeTime(row.updatedAt, now)}</span>
                    {row.snapshot && <span>turn {row.snapshot.turnCount}</span>}
                    {row.model.recovery.attempts > 0 && <span className="text-amber-400">retry {row.model.recovery.attempts}</span>}
                    {!row.snapshot && <span>No observed turns</span>}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {primary && <Button size="xs" variant={bucket === "needs_you" ? "secondary" : "outline"}
                      onClick={() => void doPrimary(row)}>{primary.label(ctx)}</Button>}
                    <Button size="xs" variant="ghost" onClick={() => void openSession(row.session.id)}>Open</Button>
                    {bucket === "recently_stopped" && <Button size="xs" variant="ghost"
                      onClick={() => snooze(row)}>Snooze 1h</Button>}
                  </div>
                </article>;
              })}
              {showMore(bucket)}
            </div>
          </section>
        ))}
      </div>
      <div className="grid min-w-0 grid-cols-1 items-start gap-3 lg:grid-cols-2">
        <div id="chatgpt-dashboard-idle">{secondary("idle", "Idle")}</div>
        <div className="flex min-w-0 flex-col gap-3">
          <div id="chatgpt-dashboard-snoozed">{secondary("snoozed", "Snoozed")}</div>
          <div id="chatgpt-dashboard-completed">{secondary("completed", "Completed today")}</div>
        </div>
      </div>
      <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-2"><Clock3Icon className="size-3.5" />Recovery: {maintenancePaused ? "Paused" : recoveryCount + " tracked"}</span>
        <span>J/K: select · Enter: open · S: snooze · C: complete</span>
        <span className="flex items-center gap-1"><ArchiveIcon className="size-3.5" /> Hidden excluded · {estimatedRendererHeap()}</span>
      </footer>
    </main>
  );
}
