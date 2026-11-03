import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "./app-context.ts";
import { Icon } from "./Icons.tsx";
import { AIChatsSidebar } from "./AIChatsSidebar.tsx";
import { nativeMori, type MoriMenuItem } from "./backend.ts";
import {
  createChatSession, loadChatSessions, normalizedChatGPTUrl, saveChatSessions,
  type MoriChatSession, type MoriChatActivity,
} from "./chatgpt-sessions.ts";
import { chatGPTConversationIdFromUrl } from "../../web/src/chatGPTConversationIdentity.ts";
import { inspectChatGPTPage, type PageInspection } from "../../web/src/chatGPTSessionDom.ts";
import { buildChatGPTSessionContextMenu, buildChatGPTProjectContextMenu } from "../../web/src/chatGPTSessionContextMenu.ts";
import { useChatBatchWorker } from "./useChatBatchWorker.ts";
import { checkRow } from "./insights.ts";

type Guest = HTMLElement & {
  getURL: () => string;
  executeJavaScript: (expression: string) => Promise<unknown>;
  reload: () => void;
};

const HOME = "https://chatgpt.com/";
const INSPECT = `(${inspectChatGPTPage.toString()})({from:"end",count:0,includeMessages:false,maxMessageChars:1})`;
const ACTIVE_KEY = (projectId: string) => `mori.ai-chats.active:${projectId}`;
const PREF_OPEN_KEY = "mori.ai-chats.sidebar-open";
const GROUPS_KEY = (projectId: string) => `mori.ai-chats.sidebar-groups:${projectId}`;
function readGroups(projectId: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(GROUPS_KEY(projectId)) ?? "[]");
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).slice(0, 80) : [];
  } catch { return []; }
}
const MINUTE = 60_000;

const selectInitial = (projectId: string, sessions: MoriChatSession[]): string | null => {
  const open = sessions.filter(s => s.projectId === projectId && !s.hidden);
  const preferred = localStorage.getItem(ACTIVE_KEY(projectId));
  return open.find(s => s.id === preferred && (s.snoozedUntil ?? 0) <= Date.now())?.id ??
    open.find(s => (s.snoozedUntil ?? 0) <= Date.now())?.id ?? null;
};

function snoozePresets(now: Date) {
  const hour = new Date(now.getTime() + 60 * MINUTE);
  const three = new Date(now.getTime() + 180 * MINUTE);
  const evening = new Date(now);
  evening.setHours(21, 0, 0, 0);
  if (evening.getTime() <= now.getTime()) evening.setDate(evening.getDate() + 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const clock = (time: Date) => time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return [
    { id: "hour", label: "1 hour", whenLabel: clock(hour), until: hour.getTime() },
    { id: "three-hours", label: "3 hours", whenLabel: clock(three), until: three.getTime() },
    { id: "evening", label: "Evening", whenLabel: `${evening.toLocaleDateString()} ${clock(evening)}`, until: evening.getTime() },
    { id: "tomorrow", label: "Tomorrow", whenLabel: clock(tomorrow), until: tomorrow.getTime() },
  ];
}

function browserActivity(page: PageInspection): MoriChatActivity {
  if (page.connectionInterrupted) return "interrupted";
  if (page.conversationFull || page.stuck) return "invalid";
  return page.activity;
}

interface FallbackMenuState {
  items: MoriMenuItem[];
  x: number;
  y: number;
  onPick: (action: string) => void;
}

/** The browser preview uses the same menu data as native Mori, where Electron
 * renders the very same tree with OS-native popup menus. */
function FallbackMenu({ state, close }: { state: FallbackMenuState; close: () => void }) {
  const render = (items: MoriMenuItem[], depth = 0) => items.map((item, index) => (
    <div key={`${item.id}-${index}`} className={item.separatorBefore ? "mori-ai-menu-sep" : undefined}>
      {item.children?.length
        ? <details className="mori-ai-menu-group"><summary>{item.label}<Icon name="chevron-right" size="xs" /></summary>
          <div className="mori-ai-menu-sub">{depth < 4 && render(item.children, depth + 1)}</div>
        </details>
        : <button type="button" disabled={item.disabled} onClick={() => { state.onPick(item.id); close(); }}>
          <span>{item.checked ? "✓ " : ""}{item.label}</span>
        </button>}
    </div>
  ));
  return <>
    <div className="mori-ai-menu-backdrop" onMouseDown={close} />
    <div className="mori-ai-menu" role="menu" style={{ left: Math.min(state.x, window.innerWidth - 240), top: Math.min(state.y, window.innerHeight - 330) }}>
      {render(state.items)}
    </div>
  </>;
}

export function ChatGPTScreen() {
  const { project, prefs, actions, toast } = useApp();
  const [sessions, setSessions] = useState<MoriChatSession[]>(loadChatSessions);
  const sessionsRef = useRef(sessions);
  const [selectedId, setSelectedId] = useState<string | null>(() => selectInitial(project.id, sessions));
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem(PREF_OPEN_KEY) !== "false");
  const [permanentGroups, setPermanentGroups] = useState<string[]>(() => readGroups(project.id));
  const updateGroups = (edit: (groups: string[]) => string[]) => setPermanentGroups(current => {
    const next = edit(current);
    localStorage.setItem(GROUPS_KEY(project.id), JSON.stringify(next));
    return next;
  });
  const [clock, setClock] = useState(Date.now());
  const [fallbackMenu, setFallbackMenu] = useState<FallbackMenuState | null>(null);
  const view = useRef<Guest | null>(null);
  const loadedRef = useRef<string | null>(null);

  const projectSessions = sessions.filter(s => s.projectId === project.id);
  const active = projectSessions.find(s => s.id === selectedId && !s.hidden) ?? null;
  const activeId = active?.id ?? null;

  const patchSessions = useCallback((edit: (items: MoriChatSession[]) => MoriChatSession[]) => {
    setSessions(current => {
      const next = edit(current);
      if (next === current) return current;
      sessionsRef.current = next;
      saveChatSessions(next);
      return next;
    });
  }, []);
  const patchOne = useCallback((id: string, edit: (session: MoriChatSession) => MoriChatSession) => {
    patchSessions(items => {
      let changed = false;
      const next = items.map(s => {
        if (s.id !== id) return s;
        const updated = edit(s);
        changed ||= updated !== s;
        return updated;
      });
      return changed ? next : items;
    });
  }, [patchSessions]);

  // Selection is scoped to each Mori translation project. Changing projects
  // does not mix tabs or cookies with T3's independent ChatGPT installation.
  useEffect(() => {
    setSelectedId(selectInitial(project.id, sessionsRef.current));
    setPermanentGroups(readGroups(project.id));
  }, [project.id]);
  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY(project.id), activeId);
    else localStorage.removeItem(ACTIVE_KEY(project.id));
  }, [project.id, activeId]);
  useEffect(() => {
    localStorage.setItem(PREF_OPEN_KEY, String(sidebarOpen));
  }, [sidebarOpen]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const changeUrl = useCallback((id: string, href: string) => {
    const url = normalizedChatGPTUrl(href);
    if (!url) return;
    patchOne(id, s => s.url === url ? s : { ...s, url, changedAt: Date.now() });
  }, [patchOne]);

  const inspect = useCallback(async (id: string) => {
    const guest = view.current;
    if (!guest || loadedRef.current !== id) return;
    try {
      const page = await guest.executeJavaScript(INSPECT) as PageInspection;
      if (loadedRef.current !== id) return;
      const at = Date.now();
      const activity = browserActivity(page);
      changeUrl(id, page.url);
      patchOne(id, s => {
        const lastWorkingAt = activity === "working" ? at : s.lastWorkingAt;
        if (activity === s.activity && lastWorkingAt === s.lastWorkingAt &&
            (s.lastSeenAt ?? 0) > at - 30_000) return s;
        return { ...s, activity, lastSeenAt: at, lastWorkingAt };
      });
    } catch {
      // The guest may be navigating or detaching. Never infer an error from a
      // transient inspection failure and never retry user messages.
    }
  }, [changeUrl, patchOne]);

  useEffect(() => {
    loadedRef.current = null;
    const guest = view.current;
    if (!activeId || !guest) return;
    const id = activeId;
    patchOne(id, s => s.activity === "loading" ? s : { ...s, activity: "loading" });
    const onNavigate = () => changeUrl(id, guest.getURL());
    const onReady = () => { loadedRef.current = id; onNavigate(); void inspect(id); };
    const onTitle = (e: Event) => {
      const title = (e as Event & { title?: string }).title?.replace(/\s+[–—-]\s+ChatGPT$/, "").trim() ?? "";
      if (!title || /^(chatgpt|new chat)$/i.test(title)) return;
      patchOne(id, s => s.titleSource === "user" || s.title === title ? s :
        { ...s, title: title.slice(0, 100), changedAt: Date.now() });
    };
    const onFail = (e: Event) => {
      const code = (e as Event & { errorCode?: number }).errorCode;
      if (code !== -3) patchOne(id, s => ({ ...s, activity: "invalid" }));
    };
    guest.addEventListener("dom-ready", onReady);
    guest.addEventListener("did-navigate", onNavigate);
    guest.addEventListener("did-navigate-in-page", onNavigate);
    guest.addEventListener("page-title-updated", onTitle);
    guest.addEventListener("did-fail-load", onFail);
    return () => {
      loadedRef.current = null;
      guest.removeEventListener("dom-ready", onReady);
      guest.removeEventListener("did-navigate", onNavigate);
      guest.removeEventListener("did-navigate-in-page", onNavigate);
      guest.removeEventListener("page-title-updated", onTitle);
      guest.removeEventListener("did-fail-load", onFail);
    };
  }, [activeId, changeUrl, patchOne, inspect]);

  useEffect(() => {
    if (!activeId) return;
    const timer = window.setInterval(() => { void inspect(activeId); }, 7000);
    return () => window.clearInterval(timer);
  }, [activeId, inspect]);

  const choose = (id: string) => {
    const now = Date.now();
    patchOne(id, s => ({
      ...s, hidden: false, snoozedUntil: undefined, quickSnoozeStep: undefined,
      lastDirectInteractionAt: now,
    }));
    setSelectedId(id);
  };
  const add = () => {
    const next = createChatSession(project.id);
    patchSessions(old => [...old, next]);
    setSelectedId(next.id);
  };
  const nextUsable = (ignoreId: string) => sessionsRef.current.find(s =>
    s.projectId === project.id && s.id !== ignoreId && !s.hidden && (s.snoozedUntil ?? 0) <= Date.now())?.id ?? null;
  const close = async (id: string) => {
    const session = sessionsRef.current.find(s => s.id === id);
    if (!session) return;
    if (id === selectedId && loadedRef.current === id && view.current) {
      try {
        const draft = await view.current.executeJavaScript(`(() => {
          const input = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"],form textarea');
          return input instanceof HTMLTextAreaElement ? input.value.trim() : input?.textContent?.trim() || "";
        })()`);
        if (typeof draft === "string" && draft.length && !window.confirm("The ChatGPT composer contains unsent text. Close this local tab anyway?")) return;
      } catch { /* A closed or navigating guest has no reliable composer. */ }
    }
    if (id === selectedId) setSelectedId(nextUsable(id));
    patchSessions(old => old.filter(s => s.id !== id));
  };
  const snooze = (id: string, until: number, quickStep?: number) => {
    patchOne(id, s => ({ ...s, snoozedUntil: until, quickSnoozeStep: quickStep }));
    if (id === selectedId) setSelectedId(nextUsable(id));
  };
  const unsnooze = (id: string) => patchOne(id, s => ({
    ...s, snoozedUntil: undefined, quickSnoozeStep: undefined,
  }));
  const quickSnooze = (s: MoriChatSession) => {
    if (s.activity === "working" && s.id === activeId) {
      // T3's double-click on a working row hides it; generation isn't cancelled.
      patchOne(s.id, current => ({ ...current, hidden: true }));
      setSelectedId(nextUsable(s.id));
      return;
    }
    const presets = snoozePresets(new Date());
    const step = Math.min((s.quickSnoozeStep ?? -1) + 1, presets.length - 1);
    if (presets[step]) snooze(s.id, presets[step].until, step);
  };
  const worker = useChatBatchWorker({
    project, prefs, actions, activeId, guestRef: view, readyIdRef: loadedRef,
    toast, openSession: choose,
  });

  const move = (id: string, overId: string, asParent: boolean) => {
    const relevant = sessionsRef.current.filter(s => s.projectId === project.id);
    if (asParent) {
      const parents = new Set([id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const session of relevant) {
          if (session.parentSessionId && parents.has(session.parentSessionId) && !parents.has(session.id)) {
            parents.add(session.id); changed = true;
          }
        }
      }
      if (!parents.has(overId)) patchOne(id, s => ({ ...s, parentSessionId: overId }));
      return;
    }
    patchSessions(old => {
      const next = [...old];
      const from = next.findIndex(s => s.id === id);
      const to = next.findIndex(s => s.id === overId);
      if (from < 0 || to < 0) return old;
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(next.findIndex(s => s.id === overId), 0, moved);
      return next;
    });
  };

  const contextMenu = async (session: MoriChatSession, position: { x: number; y: number }) => {
    const relevant = sessionsRef.current.filter(s => s.projectId === project.id);
    const presets = snoozePresets(new Date());
    const projects = [...new Set([...permanentGroups, ...relevant.map(s => s.project).filter((s): s is string => Boolean(s))])].sort();
    const running = session.id === activeId && session.activity === "working";
    const t3Items = buildChatGPTSessionContextMenu({
      session, sessions: relevant, managerIds: new Set(), projects,
      snoozePresets: presets, now: Date.now(), working: running, hasTask: false,
    });
    // T3-backed controls are intentionally unavailable: Mori sessions have no
    // OpenRig seat, T3 task binding, agent reboot or Caffy registration. Do not
    // pretend local ChatGPT browser tabs are registered T3 agents.
    const unsupported = new Set(["reboot", "role:edit", "role:clear", "task:open", "awake"]);
    const adapt = (items: readonly (typeof t3Items)[number][]): MoriMenuItem[] => items.map(item => ({
      id: item.id,
      label: item.id === "copy:t3-id" ? "Local session ID" : item.label,
      ...(item.checked !== undefined ? { checked: item.checked } : {}),
      ...(item.separatorBefore ? { separatorBefore: true } : {}),
      disabled: item.disabled === true || unsupported.has(item.id) ||
        item.id.startsWith("awake:") || item.id === "unload" && running,
      ...(item.children ? { children: adapt(item.children) } : {}),
    }));
    const items: MoriMenuItem[] = [
      { id: "registry:open", label: "Open session" },
      { id: "registry:reload", label: "Reload session", disabled: session.id !== activeId },
      { id: "registry:copy_url", label: "Copy ChatGPT URL", disabled: session.url === HOME, separatorBefore: true },
      ...adapt(t3Items).filter(item => item.id !== "reboot"),
      { id: "close", label: "Close session", separatorBefore: true },
    ];
    const run = async (action: string) => {
      const current = sessionsRef.current.find(s => s.id === session.id);
      if (!current) return;
      try {
        const textToClipboard = async (text: string | null | undefined) => {
          if (!text) { toast("No saved value for this session."); return; }
          await navigator.clipboard.writeText(text);
        };
        if (action === "registry:open") choose(current.id);
        else if (action === "registry:reload") {
          if (current.id === activeId && view.current) {
            if (current.activity === "working" &&
                !window.confirm("ChatGPT is still generating. Reload this session anyway?")) return;
            view.current.reload();
            patchOne(current.id, s => ({ ...s, activity: "loading" }));
          }
        } else if (action === "registry:copy_url" || action === "copy:url")
          await textToClipboard(current.url);
        else if (action === "copy:t3-id") await textToClipboard(current.id);
        else if (action === "copy:conversation-id") await textToClipboard(chatGPTConversationIdFromUrl(current.url));
        else if (action === "copy:title") await textToClipboard(current.title);
        else if (action === "copy:parent-id") await textToClipboard(current.parentSessionId);
        else if (action === "role:toggle") patchOne(current.id, s => s.markedAsWorkerAt ?
          { ...s, markedAsWorkerAt: undefined, humanControlled: true } :
          { ...s, markedAsWorkerAt: Date.now(), humanControlled: false });
        else if (action === "project:none") patchOne(current.id, s => ({ ...s, project: undefined }));
        else if (action === "project:add") {
          const label = window.prompt("New session group name");
          if (label?.trim()) patchOne(current.id, s => ({ ...s, project: label.trim().slice(0, 100) }));
        } else if (action.startsWith("project:")) {
          const projectName = projects[Number(action.slice(8))];
          if (projectName) patchOne(current.id, s => ({ ...s, project: projectName }));
        } else if (action === "parent:detach") patchOne(current.id, s => ({ ...s, parentSessionId: null }));
        else if (action.startsWith("parent:") && action !== "parent:set") {
          const id = action.slice(7);
          if (id !== current.id && relevant.some(s => s.id === id))
            move(current.id, id, true);
        } else if (action === "verification:toggle")
          patchOne(current.id, s => ({ ...s, verificationPending: !s.verificationPending }));
        else if (action === "snooze:clear" || action === "registry:unsnooze") unsnooze(current.id);
        else if (action.startsWith("snooze:")) {
          const id = action.slice(7);
          let until = presets.find(p => p.id === id)?.until;
          if (id === "custom") {
            const minutes = Number(window.prompt("Snooze for how many minutes?", "60"));
            until = Number.isFinite(minutes) && minutes > 0 && minutes <= 7 * 24 * 60
              ? Date.now() + minutes * MINUTE : undefined;
          }
          if (until) snooze(current.id, until);
        } else if (action.startsWith("highlight:")) {
          const color = action.slice(10);
          patchOne(current.id, s => ({ ...s, borderColor: color === "none" ? undefined : color }));
        } else if (action === "hide") {
          const nextHidden = !current.hidden;
          patchOne(current.id, s => ({ ...s, hidden: nextHidden }));
          if (nextHidden && selectedId === current.id) setSelectedId(nextUsable(current.id));
        } else if (action === "stop" && current.id === activeId && view.current) {
          const stopped = await view.current.executeJavaScript(`(() => {
            const button = document.querySelector('button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]');
            if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
            button.click(); return true;
          })()`);
          if (!stopped) toast("No active Stop control found.");
        } else if (action === "unload" && current.id === selectedId) {
          // Never discard an unsent draft when unloading.
          const draft = await view.current?.executeJavaScript(`(() => {
            const el = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][role="textbox"],textarea');
            return el instanceof HTMLTextAreaElement ? el.value.trim() : el?.textContent?.trim() || "";
          })()`);
          if (draft) { toast("Cannot unload a session with unsent composer text."); return; }
          patchOne(current.id, s => ({ ...s, activity: "unloaded" }));
          setSelectedId(nextUsable(current.id));
        } else if (action === "close") await close(current.id);
      } catch (error) {
        toast(error instanceof Error ? error.message : "Session action could not complete.");
      }
    };
    const backend = nativeMori();
    if (backend?.chatSessionMenu) {
      try {
        const action = await backend.chatSessionMenu(items, position);
        if (action) await run(action);
      } catch (error) {
        toast(error instanceof Error ? error.message : "Could not show the session menu.");
      }
    } else setFallbackMenu({ items, x: position.x, y: position.y, onPick: action => { void run(action); } });
  };

  const showGroupMenu = async (group: string, point: { x: number; y: number }) => {
    const members = sessionsRef.current.filter(s => s.projectId === project.id && (s.project?.trim() || "Other") === group);
    const presets = snoozePresets(new Date());
    const allSnoozed = members.length > 0 && members.every(s => (s.snoozedUntil ?? 0) > Date.now());
    const t3Items = buildChatGPTProjectContextMenu({
      permanent: permanentGroups.includes(group), snoozed: allSnoozed, snoozePresets: presets,
    });
    const adapt = (items: readonly (typeof t3Items)[number][]): MoriMenuItem[] => items.map(item => ({
      id: item.id, label: item.label,
      ...(item.separatorBefore ? { separatorBefore: true } : {}),
      ...(item.children ? { children: adapt(item.children) } : {}),
    }));
    const items = adapt(t3Items);
    const run = (action: string) => {
      if (action === "group:rename") {
        const nextName = window.prompt("Rename session group", group)?.trim();
        if (!nextName || nextName === group) return;
        if (nextName.toLowerCase() === "other") { toast("Other is reserved for ungrouped sessions."); return; }
        patchSessions(items => items.map(s => s.projectId === project.id && s.project === group ? { ...s, project: nextName } : s));
        updateGroups(names => names.map(name => name === group ? nextName : name));
      } else if (action === "group:permanent") {
        updateGroups(names => names.includes(group) ? names.filter(name => name !== group) : [...names, group]);
      } else if (action === "snooze:clear") {
        patchSessions(items => items.map(s => members.some(m => m.id === s.id)
          ? { ...s, snoozedUntil: undefined, quickSnoozeStep: undefined } : s));
      } else if (action.startsWith("snooze:")) {
        let until = presets.find(p => action === `snooze:${p.id}`)?.until;
        if (action === "snooze:custom") {
          const minutes = Number(window.prompt("Snooze group for how many minutes?", "60"));
          if (Number.isFinite(minutes) && minutes > 0 && minutes <= 7 * 24 * 60) until = Date.now() + minutes * MINUTE;
        }
        if (until) {
          patchSessions(items => items.map(s => members.some(m => m.id === s.id) ? { ...s, snoozedUntil: until } : s));
          if (activeId && members.some(m => m.id === activeId)) setSelectedId(null);
        }
      }
    };
    const backend = nativeMori();
    if (backend?.chatSessionMenu) {
      try {
        const action = await backend.chatSessionMenu(items, point);
        if (action) run(action);
      } catch (cause) { toast(cause instanceof Error ? cause.message : "Could not show session group menu."); }
    } else setFallbackMenu({ items, x: point.x, y: point.y, onPick: run });
  };

  return (
    <div className="mori-ai" aria-label="AI Chats">
      <div className="mori-ai-browser">
        {active ? <webview
          key={active.id}
          ref={element => { view.current = element as Guest | null; }}
          src={active.url} partition="persist:mori-chatgpt"
          data-preview-tab={`mori-chatgpt:${active.id}`}
          style={{ display: "flex", width: "100%", height: "100%" }} /> :
          <div className="mori-ai-no-browser">
            <Icon name="sparkle" />
            <span>No AI chat selected</span>
            <button type="button" onClick={add}>New chat</button>
          </div>}
      </div>
      <AIChatsSidebar sessions={projectSessions} activeId={activeId}
        collapsed={!sidebarOpen} now={clock}
        onCollapse={() => setSidebarOpen(v => !v)}
        onCreate={add} onSelect={choose} onClose={id => { void close(id); }}
        onRename={(id, title) => patchOne(id, s => ({ ...s, title, titleSource: "user" }))}
        onMenu={(session, point) => { void contextMenu(session, point); }}
        onGroupMenu={(group, point) => { void showGroupMenu(group, point); }} permanentGroups={permanentGroups}
        onMove={move}
        onAssignGroup={(id, group) => patchOne(id, s => ({ ...s, project: group === "Other" ? undefined : group }))}
        onDoubleClick={quickSnooze} onUnsnooze={unsnooze}
        onRunBatch={() => { void worker.run(); }}
        onReviewBatch={() => worker.setReviewOpen(true)}
        batchStatus={worker.status} batchPending={!!worker.job}
        batchReady={worker.job?.stage === "ready"} batchCount={worker.draftable.length}
        batchBusy={worker.sending} />
      {worker.job && worker.job.stage !== "ready" && <div className="mori-ai-batch-floating" role="status">
        <span title={worker.job.folder ?? ""}>{worker.status}</span>
        {worker.job.request.sessionId !== activeId
          ? <button type="button" onClick={worker.resume}>Open batch session</button>
          : <button type="button" disabled={worker.checking} onClick={() => { void worker.check(); }}>Check reply</button>}
        <button type="button" onClick={worker.discard}>Discard tracking</button>
      </div>}
      {worker.job?.stage === "ready" && worker.reviewOpen && <section className="mori-ai-batch-review" aria-label="AI batch proposals">
        <header><b>ChatGPT · {worker.job.proposals?.length} AI drafts</b>
          <button type="button" aria-label="Close review" onClick={() => worker.setReviewOpen(false)}><Icon name="x" size="xs" /></button>
        </header>
        <small>From {worker.job.request.files.map(file => file.name).join(", ")} · source snapshots saved on PC.</small>
        <div className="mori-ai-batch-lines">{worker.job.proposals?.map(({id,japanese}) => {
          const row = project.rows.find(row => row.id === id);
          const warnings = row ? checkRow({ ...row, final: japanese }, prefs.glossaryEnabled ? project.glossary : []) : [];
          return <article key={id}><b>{id}</b><p>{row?.source ?? "Source missing"}</p>
            <div lang="ja">{japanese}</div>
            {warnings.map((warning,index) => <small className="mori-ai-batch-warning" key={index}>{warning.message}</small>)}
          </article>;
        })}</div>
        <footer><button type="button" onClick={worker.discard}>Discard</button>
          <button className="mori-ai-approve" type="button" onClick={worker.apply}>Save to AI drafts</button></footer>
      </section>}
      {fallbackMenu && <FallbackMenu state={fallbackMenu} close={() => setFallbackMenu(null)} />}
    </div>
  );
}
