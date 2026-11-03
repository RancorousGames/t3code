import { useEffect, useMemo, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import { Icon } from "./Icons.tsx";
import type { MoriChatSession } from "./chatgpt-sessions.ts";
import { ChatGPTSessionIcon } from "../../web/src/components/sidebar/ChatGPTSessionIcon.tsx";
import { chatGPTSessionDisplayRole } from "../../web/src/components/sidebar/chatGPTSidebarVisuals.ts";

/** Mori adapter for the T3 ChatGPT sidebar's visual language. T3's session store,
 * recovery coordinator and OpenRig controls cannot be mounted in Mori's isolated
 * Electron profile; the row state and native menu model are shared instead. */
export type MoriSidebarAge =
  | "working" | "recent" | "inactive" | "snoozed" | "unloaded" | "unloaded-recent"
  | "unloaded-working" | "interrupted" | "invalid" | "unknown" | "loading";

export function moriSidebarAge(session: MoriChatSession, activeId: string | null, now: number): MoriSidebarAge {
  if ((session.snoozedUntil ?? 0) > now) return "snoozed";
  const selected = session.id === activeId;
  if (!selected) {
    const elapsed = now - (session.lastSeenAt ?? 0);
    const recent = elapsed >= 0 && elapsed < 2 * 60 * 60_000;
    return recent
      ? session.activity === "working" ? "unloaded-working" : "unloaded-recent"
      : "unloaded";
  }
  if (session.activity === "working") return "working";
  if (session.activity === "interrupted") return "interrupted";
  if (session.activity === "invalid") return "invalid";
  if (session.activity === "loading") return "loading";
  if (session.activity === "unknown") return "unknown";
  return (session.lastWorkingAt ?? 0) > now - 2 * 60 * 60_000 ? "recent" : "inactive";
}

type ViewMode = "normal" | "snoozed" | "hidden";
export interface AIChatsSidebarProps {
  sessions: MoriChatSession[];
  activeId: string | null;
  collapsed: boolean;
  onCollapse: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onMenu: (session: MoriChatSession, point: { x: number; y: number }) => void;
  onGroupMenu: (group: string, point: { x: number; y: number }) => void;
  permanentGroups: readonly string[];
  onMove: (id: string, overId: string, asParent: boolean) => void;
  onAssignGroup: (id: string, group: string) => void;
  onDoubleClick: (session: MoriChatSession) => void;
  onUnsnooze: (id: string) => void;
  onRunBatch: () => void;
  onReviewBatch: () => void;
  batchStatus: string;
  batchPending: boolean;
  batchReady: boolean;
  batchCount: number;
  batchBusy: boolean;
  now: number;
}

function orderedSessions(items: MoriChatSession[], activeId: string | null, now: number, mode: "activity" | "started" | "manual") {
  if (mode === "manual") return items;
  if (mode === "started") return [...items].sort((a, b) => (b.createdAt ?? b.changedAt) - (a.createdAt ?? a.changedAt));
  const priority = (s: MoriChatSession) => {
    const age = moriSidebarAge(s, activeId, now);
    if (age === "working") return 0;
    if (age === "interrupted" || age === "invalid") return 1;
    if (age === "recent" || age === "unloaded-working") return 2;
    if (s.id === activeId) return 3;
    if (age === "unloaded-recent") return 4;
    if (age === "inactive") return 5;
    return 6;
  };
  return [...items].sort((a, b) => priority(a) - priority(b) ||
    (b.lastDirectInteractionAt ?? b.changedAt) - (a.lastDirectInteractionAt ?? a.changedAt));
}

export function AIChatsSidebar({
  sessions, activeId, collapsed, onCollapse, onCreate, onSelect, onClose,
  onRename, onMenu, onGroupMenu, permanentGroups, onMove, onAssignGroup, onDoubleClick, onUnsnooze,
  onRunBatch, onReviewBatch, batchStatus, batchPending, batchReady, batchCount, batchBusy, now,
}: AIChatsSidebarProps) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ViewMode>("normal");
  const [sort, setSort] = useState<"activity" | "started" | "manual">(() => {
    const saved = localStorage.getItem("mori.ai-chats.sidebar-sort");
    return saved === "started" || saved === "manual" ? saved : "activity";
  });
  useEffect(() => localStorage.setItem("mori.ai-chats.sidebar-sort", sort), [sort]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [showWorkers, setShowWorkers] = useState(true);
  const [hideUnloaded, setHideUnloaded] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [foldedGroups, setFoldedGroups] = useState<Set<string>>(() => new Set());
  const [dragged, setDragged] = useState<string | null>(null);

  const hidden = sessions.filter(s => s.hidden);
  const snoozed = sessions.filter(s => !s.hidden && (s.snoozedUntil ?? 0) > now);
  const allVisible = sessions.filter(s => !s.hidden && (s.snoozedUntil ?? 0) <= now);
  const visible = useMemo(() => {
    const pool = query.trim()
      ? sessions
      : mode === "hidden" ? hidden : mode === "snoozed" ? snoozed : allVisible;
    const needle = query.trim().toLowerCase();
    return orderedSessions(pool.filter(s =>
      (!needle || [s.title, s.project ?? "", s.id].join(" ").toLowerCase().includes(needle)) &&
      (showWorkers || chatGPTSessionDisplayRole(s, false) !== "worker") &&
      (!hideUnloaded || needle || mode !== "normal" || moriSidebarAge(s, activeId, now) !== "unloaded"),
    ), activeId, now, sort);
  }, [sessions, activeId, now, mode, sort, query, showWorkers, hideUnloaded]);
  const groups = useMemo(() => {
    const names = [...new Set([...permanentGroups, ...visible.map(s => s.project?.trim() || "Other")])];
    if (names.length === 1 && names[0] === "Other") return [{ name: "", rows: visible }];
    return names.map(name => ({ name, rows: visible.filter(s => (s.project?.trim() || "Other") === name) }));
  }, [visible, permanentGroups]);

  const beginRename = (session: MoriChatSession) => { setRenaming(session.id); setDraftTitle(session.title); };
  const finishRename = (id: string) => {
    if (draftTitle.trim()) onRename(id, draftTitle.trim());
    setRenaming(null);
  };
  const contextMenu = (session: MoriChatSession, e: MouseEvent) => {
    e.preventDefault();
    onMenu(session, { x: e.clientX, y: e.clientY });
  };
  const onDrop = (e: DragEvent, target: MoriChatSession) => {
    e.preventDefault();
    const source = e.dataTransfer.getData("text/x-mori-session") || dragged;
    setDragged(null);
    if (source && source !== target.id) {
      onMove(source, target.id, e.shiftKey);
      if (!e.shiftKey) setSort("manual");
    }
  };
  useEffect(() => {
    const renameKey = (event: KeyboardEvent) => {
      if (event.key !== "F2" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable]")) return;
      const chosen = sessions.find(s => s.id === activeId);
      if (!chosen || collapsed) return;
      event.preventDefault();
      beginRename(chosen);
    };
    window.addEventListener("keydown", renameKey, true);
    return () => window.removeEventListener("keydown", renameKey, true);
  }, [sessions, activeId, collapsed]);

  if (collapsed) return (
    <button type="button" className="mori-ai-expand" title="Show AI Chats sidebar"
      aria-label="Show AI Chats sidebar" aria-expanded={false} onClick={onCollapse}>
      <Icon name="panel" size="sm" />
    </button>
  );

  return (
    <aside className="mori-ai-side" aria-label="AI Chats sessions">
      <header className="mori-ai-side-head">
        <span className="mori-ai-side-label">ChatGPT</span>
        <span className="mori-ai-count" title="Visible sessions">{allVisible.length}</span>
        <div className="mori-ai-spacer" />
        <button type="button" className="mori-ai-icon-btn" title="New ChatGPT session" aria-label="New ChatGPT session" onClick={onCreate}>
          <ChatGPTSessionIcon />
        </button>
        <button type="button" className="mori-ai-icon-btn" title={sort === "activity" ? "Sort by creation" : "Sort by activity"}
          aria-label="Toggle session sort" onClick={() => setSort(c => c === "activity" ? "started" : "activity")}>
          <Icon name="history" size="sm" />
        </button>
        <button type="button" className="mori-ai-icon-btn" title="Search sessions" aria-label="Search sessions"
          aria-pressed={searching} onClick={() => { setSearching(c => !c); setQuery(""); }}>
          <Icon name="search" size="sm" />
        </button>
        <button type="button" className="mori-ai-icon-btn" title="Session list options" aria-label="Session list options"
          aria-expanded={optionsOpen} onClick={() => setOptionsOpen(c => !c)}>
          <Icon name="sliders" size="sm" />
        </button>
        <button type="button" className="mori-ai-icon-btn" title="Collapse right sidebar" aria-label="Collapse AI Chats sidebar" onClick={onCollapse}>
          <Icon name="chevron-right" size="sm" />
        </button>
      </header>
      {optionsOpen && <div className="mori-ai-options">
        <label><input type="checkbox" checked={showWorkers} onChange={e => setShowWorkers(e.target.checked)} />Show workers</label>
        <label><input type="checkbox" checked={hideUnloaded} onChange={e => setHideUnloaded(e.target.checked)} />Hide unloaded</label>
        <button type="button" onClick={() => { setMode("normal"); setOptionsOpen(false); }}>All active sessions</button>
        <button type="button" onClick={() => { setMode("snoozed"); setOptionsOpen(false); }}>Snoozed <small>{snoozed.length}</small></button>
        <button type="button" onClick={() => { setMode("hidden"); setOptionsOpen(false); }}>Hidden <small>{hidden.length}</small></button>
      </div>}
      {searching && <div className="mori-ai-search"><Icon name="search" size="xs" />
        <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Find sessions…" aria-label="Find AI sessions" />
        {query && <button type="button" title="Clear search" onClick={() => setQuery("")}><Icon name="x" size="xs" /></button>}
      </div>}
      {mode !== "normal" && !query.trim() && <div className="mori-ai-mode">
        <b>{mode === "hidden" ? "Hidden" : "Snoozed"} · {mode === "hidden" ? hidden.length : snoozed.length}</b>
        <button type="button" onClick={() => setMode("normal")}>Back</button>
      </div>}
      <div className="mori-ai-session-list">
        {groups.map(group => (
          <section key={group.name || "_default"} className="mori-ai-group">
            {group.name && <button type="button" className="mori-ai-group-heading"
              aria-expanded={!foldedGroups.has(group.name)}
              onContextMenu={event => { event.preventDefault(); onGroupMenu(group.name, { x: event.clientX, y: event.clientY }); }}
              onDragOver={e => { if (dragged) e.preventDefault(); }}
              onDrop={e => { e.preventDefault(); const source = e.dataTransfer.getData("text/x-mori-session") || dragged; if (source) onAssignGroup(source, group.name); setDragged(null); }}
              onClick={() => setFoldedGroups(old => {
                const next = new Set(old); if (next.has(group.name)) next.delete(group.name); else next.add(group.name); return next;
              })}>
              <Icon name={foldedGroups.has(group.name) ? "chevron-right" : "chevron-down"} size="xs" />
              <span>{group.name}</span><small>{group.rows.length}</small>
            </button>}
            {!foldedGroups.has(group.name) && group.rows.map(session => {
              const age = moriSidebarAge(session, activeId, now);
              const isSelected = session.id === activeId;
              const role = chatGPTSessionDisplayRole(session, false);
              const parent = session.parentSessionId ? sessions.find(s => s.id === session.parentSessionId) : null;
              return <div key={session.id}
                className={`mori-ai-session ${isSelected ? "selected" : ""} ${session.verificationPending ? "verification" : ""} role-${role}`}
                data-age={age} data-highlight={session.borderColor || undefined}

                onDragOver={e => { if (dragged && dragged !== session.id) e.preventDefault(); }}
                onDrop={e => onDrop(e, session)}
                onContextMenu={e => contextMenu(session, e)}
                style={{ paddingLeft: parent ? 18 : 4 }}
                title={`${session.title}\n${age.replaceAll("-", " ")}${parent ? `\nChild of: ${parent.title}` : ""}\nRight-click for session menu`}>
                <button type="button" className="mori-ai-handle" draggable
                  onDragStart={e => { e.dataTransfer.setData("text/x-mori-session", session.id); e.dataTransfer.effectAllowed = "move"; setDragged(session.id); }}
                  onDragEnd={() => setDragged(null)}
                  title="Drag to reorder · Shift-drop to set parent" aria-label={`Drag ${session.title}`}>
                  {parent ? <Icon name="chevron-right" size="xs" /> : <ChatGPTSessionIcon />}
                </button>
                {renaming === session.id ? <input className="mori-ai-rename" autoFocus
                    value={draftTitle} onChange={e => setDraftTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") finishRename(session.id); if (e.key === "Escape") setRenaming(null); }}
                    onBlur={() => finishRename(session.id)} aria-label="Rename chat session" />
                  : <button type="button" className="mori-ai-row-title"
                      aria-current={isSelected ? "page" : undefined} onClick={() => onSelect(session.id)}
                      onDoubleClick={() => onDoubleClick(session)}>
                      {session.verificationPending && <span className="mori-ai-verify" title="Awaiting verification">◷</span>}
                      {role === "worker" && <span className="mori-ai-role" title="Worker">✦</span>}
                      <span>{session.title}</span>
                    </button>}
                {(session.snoozedUntil ?? 0) > now && <button type="button" className="mori-ai-row-action"
                    title="Unsnooze" aria-label={`Unsnooze ${session.title}`} onClick={() => onUnsnooze(session.id)}>
                    <Icon name="history" size="xs" />
                  </button>}
                <button type="button" className="mori-ai-row-action close" title="Close local session"
                  aria-label={`Close ${session.title}`} onClick={() => onClose(session.id)}><Icon name="x" size="xs" /></button>
                <button type="button" className="mori-ai-row-action more" title="Session actions"
                  aria-label={`Actions for ${session.title}`}
                  onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); onMenu(session, { x: rect.right - 10, y: rect.bottom }); }}>
                  <Icon name="more" size="xs" />
                </button>
                <button type="button" className="mori-ai-rename-access" title="Rename (F2)"
                  aria-label={`Rename ${session.title}`} onClick={() => beginRename(session)} tabIndex={-1}>Rename</button>
              </div>;
            })}
          </section>
        ))}
        {!visible.length && <p className="mori-ai-empty">{query ? "No matching sessions." :
          mode === "hidden" ? "No hidden sessions." : mode === "snoozed" ? "No snoozed sessions." : "No sessions. Use + to start one."}</p>}
      </div>
      <div className="mori-ai-batch-actions">
        {batchStatus && <span className="mori-ai-batch-status" role="status" title={batchStatus}>{batchStatus}</span>}
        <button type="button" className="mori-ai-batch-button" disabled={batchBusy || (batchPending && !batchReady) || (!batchPending && !batchCount)}
          onClick={batchReady ? onReviewBatch : onRunBatch}
          title={batchReady ? "Review ChatGPT JSON proposals" : "Send up to three eligible lines to the current ChatGPT session with inline instruction and context files"}>
          <Icon name="sparkle" size="xs" />
          {batchBusy ? "Sending…" : batchReady ? "Review AI drafts" : batchPending ? "Batch in progress" : `Translate ${batchCount} lines`}
        </button>
      </div>
      <footer className="mori-ai-side-foot">
        {hidden.length > 0 && <button type="button" onClick={() => setMode(mode === "hidden" ? "normal" : "hidden")}>Hidden {hidden.length}</button>}
        {snoozed.length > 0 && <button type="button" onClick={() => setMode(mode === "snoozed" ? "normal" : "snoozed")}>Snoozed {snoozed.length}</button>}
        <div className="mori-ai-spacer" />
        <button type="button" onClick={onCreate}><Icon name="plus" size="xs" />New</button>
      </footer>
    </aside>
  );
}
