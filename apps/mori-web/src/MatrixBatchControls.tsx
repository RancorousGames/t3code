import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./app-context.ts";
import { Icon } from "./Icons.tsx";
import { loadChatSessions } from "./chatgpt-sessions.ts";
import { canDraft } from "./ai-batch.ts";
import { MATRIX_BATCH_EVENT, activateMatrixBatch, eligibleMatrixRows, newMatrixBatchPlan,
  readMatrixBatchPlan, readMatrixBatchSettings, saveMatrixBatchPlan, saveMatrixBatchSettings,
  type MatrixBatchSettings } from "./matrix-batch.ts";

const PRESETS = [5, 20, 100, 300];
export function MatrixBatchControls() {
  const { project, activeRow, view, go, toast } = useApp();
  const [settings, setSettings] = useState(() => readMatrixBatchSettings(project.id));
  const [plan, setPlan] = useState(() => readMatrixBatchPlan(project.id));
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLDivElement>(null);
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const sessions = useMemo(() => loadChatSessions().filter(s => s.projectId === project.id && !s.hidden), [project.id]);
  const file = view.file ?? activeRow?.sourceFile ?? null;
  const activeSession = localStorage.getItem(`mori.ai-chats.active:${project.id}`);
  const sessionId = sessions.some(s => s.id === settings.sessionId) ? settings.sessionId
    : sessions.some(s => s.id === activeSession) ? activeSession : sessions[0]?.id ?? null;
  const chosen = { ...settings, sessionId };
  const eligible = eligibleMatrixRows(project, chosen, activeRow?.id ?? null, file);
  const busy = plan?.stage === "running" || plan?.stage === "paused";

  useEffect(() => {
    setSettings(readMatrixBatchSettings(project.id));
    setPlan(readMatrixBatchPlan(project.id));
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === project.id) setPlan(readMatrixBatchPlan(project.id));
    };
    window.addEventListener(MATRIX_BATCH_EVENT, listener);
    return () => window.removeEventListener(MATRIX_BATCH_EVENT, listener);
  }, [project.id]);

  useEffect(() => {
    const grid = document.querySelector(".matrix");
    if (!grid) return;
    const context = (event: Event) => {
      const mouse = event as MouseEvent;
      if (!(mouse.target instanceof Element) || mouse.target.closest("textarea,input")) return;
      const row = mouse.target.closest<HTMLElement>("[data-row-id]");
      if (!row?.dataset.rowId) return;
      mouse.preventDefault();
      setRowMenu({ id: row.dataset.rowId, x: mouse.clientX, y: mouse.clientY });
    };
    grid.addEventListener("contextmenu", context);
    return () => grid.removeEventListener("contextmenu", context);
  }, [project.id]);

  useEffect(() => {
    if (!open && !rowMenu) return;
    const outside = (event: PointerEvent) => {
      if (open && event.target instanceof Node && !trigger.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); setRowMenu(null); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open, rowMenu]);

  const patch = (value: Partial<MatrixBatchSettings>) => {
    const next = { ...settings, ...value };
    setSettings(next);
    saveMatrixBatchSettings(project.id, next);
  };
  const start = (count = settings.size, focusId = activeRow?.id ?? null, fromRow = false) => {
    if (busy) { toast("Pause or stop the existing translation queue first."); return; }
    if (localStorage.getItem(`mori.ai-chat.batch:${project.id}`)) {
      toast("A ChatGPT reply is still being tracked; resolve it in AI Chats first.");
      go("chatgpt"); return;
    }
    if (!sessionId) { toast("Open a ChatGPT session in AI Chats first."); go("chatgpt"); return; }
    const next = newMatrixBatchPlan(project, { ...chosen, size: count, ...(fromRow ? { start: "selected" as const } : {}) },
      focusId, fromRow ? project.rows.find(row => row.id === focusId)?.sourceFile ?? null : file);
    if (!next) { toast("No eligible untranslated lines in this scope."); return; }
    saveMatrixBatchSettings(project.id, chosen);
    saveMatrixBatchPlan(next);
    activateMatrixBatch(next.sessionId);
    setOpen(false);
    setRowMenu(null);
  };
  const changeStage = (stage: "running" | "paused" | "stopped") => {
    if (!plan) return;
    if (stage === "running") {
      const pending = localStorage.getItem(`mori.ai-chat.batch:${project.id}`);
      if (pending && JSON.parse(pending).stage === "failed") {
        toast("Resolve the failed ChatGPT batch in AI Chats before resuming.");
        go("chatgpt"); return;
      }
    }
    saveMatrixBatchPlan({ ...plan, stage, error: stage === "running" ? undefined : plan.error });
    if (stage === "running") activateMatrixBatch(plan.sessionId);
  };
  return <div className="mori-matrix-batch-controls">
    {plan && <span className="mori-matrix-batch-progress" role="status">
      {plan.stage === "paused" ? "Paused · " : plan.stage === "stopped" ? "Stopped · " : plan.stage === "done" ? "Done · " : "Translating "}
      {plan.cursor}/{plan.ids.length}{plan.skipped ? ` · ${plan.skipped} skipped` : ""}
    </span>}
    {plan?.stage === "running" && <button type="button" className="btn sm outline" onClick={() => changeStage("paused")}>Pause</button>}
    {plan?.stage === "paused" && <button type="button" className="btn sm outline" onClick={() => changeStage("running")}>Resume</button>}
    {busy && <button type="button" className="btn sm outline" onClick={() => { activateMatrixBatch(plan!.sessionId); go("chatgpt"); }}>View chat</button>}
    <div className="mori-matrix-batch-trigger" ref={trigger}>
      <button type="button" className="btn primary sm" disabled={busy} onClick={() => start()} title="Translate using saved batch settings">
        <Icon name="sparkle" size="xs" /> Translate
      </button>
      <button type="button" className="btn sm outline" aria-label="Batch translation options" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <Icon name="chevron-down" size="xs" />
      </button>
      {open && <div className="mori-matrix-batch-popover" role="group" aria-label="Batch translation settings">
        <b>AI Translation</b>
        <span className="mori-batch-label">Start from</span>
        <label><input type="radio" name="batch-start" checked={settings.start === "selected"} onChange={() => patch({ start: "selected" })} />
          Selected line {activeRow ? `(${activeRow.id})` : ""}</label>
        <label><input type="radio" name="batch-start" checked={settings.start === "first"} onChange={() => patch({ start: "first" })} />
          First untranslated line</label>
        <span className="mori-batch-label">Scope</span>
        <select value={settings.scope} aria-label="Translation scope" onChange={event => patch({ scope: event.target.value as MatrixBatchSettings["scope"] })}>
          <option value="project">Entire project</option>
          <option value="file" disabled={!file}>Current file{file ? ` · ${file.split("/").at(-1)}` : ""}</option>
        </select>
        <span className="mori-batch-label">Batch size</span>
        <div className="mori-matrix-batch-sizes">
          {PRESETS.map(size => <button key={size} type="button" className={settings.size === size ? "selected" : ""} onClick={() => patch({ size })}>{size}</button>)}
          <button type="button" className={!PRESETS.includes(settings.size) ? "selected" : ""} onClick={() => patch({ size: 1 })}>Custom</button>
        </div>
        {!PRESETS.includes(settings.size) && <label>Lines <input type="number" min={1} max={100000} value={settings.size}
          onChange={event => { const n = Number(event.target.value); if (Number.isInteger(n) && n > 0 && n <= 100000) patch({ size: n }); }} /></label>}
        <span className="mori-batch-label">AI session</span>
        <select value={sessionId ?? ""} aria-label="ChatGPT session" onChange={event => patch({ sessionId: event.target.value || null })}>
          {!sessions.length && <option value="">No sessions — open AI Chats</option>}
          {sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
        <small>{eligible.length} eligible · {Math.min(eligible.length, settings.size)} selected · 5 per request</small>
        {plan?.stage === "paused" && <button type="button" className="btn sm outline" onClick={() => changeStage("stopped")}>Stop previous queue</button>}
        <button type="button" className="btn primary" disabled={busy || !eligible.length || !sessionId} onClick={() => start()}>
          Translate {Math.min(eligible.length, settings.size)} lines
        </button>
      </div>}
    </div>
    {rowMenu && <>
      <button type="button" className="mori-row-batch-backdrop" aria-label="Close row menu" onClick={() => setRowMenu(null)} />
      <div className="mori-row-batch-menu" role="menu"
        style={{ left: Math.max(8, Math.min(rowMenu.x, window.innerWidth - 200)), top: Math.max(8, Math.min(rowMenu.y, window.innerHeight - 95)) }}>
        <button type="button" role="menuitem" disabled={busy || !project.rows.some(row => row.id === rowMenu.id && canDraft(row) && !row.ai?.trim())}
          onClick={() => start(1, rowMenu.id, true)}>Translate this line</button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => start(5, rowMenu.id, true)}>Translate next 5</button>
      </div>
    </>}
  </div>;
}
