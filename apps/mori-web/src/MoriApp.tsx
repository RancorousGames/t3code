import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppContext, type AppValue, type EditorClickSelection, type ModalState, type PopState, type Screen } from "./app-context.ts";
import { StatusBar, Titlebar } from "./Chrome.tsx";
import { WindowControls } from "./WindowControls.tsx";
import { ChatGPTScreen } from "./ChatGPTScreen.tsx";
import { ShortcutsModal, PaletteModal, TemplatesModal } from "./Dialogs.tsx";
import { ImportWizard } from "./ImportWizard.tsx";
import { droppedSources, type DroppedSource } from "./drop-import.ts";
import { Icon, IconSprite } from "./Icons.tsx";
import { MatrixScreen } from "./Matrix.tsx";
import { Modal, PopoverFrame } from "./Overlays.tsx";
import { NotificationViewport, notify } from "./Notifications.tsx";
import type { GoogleStagedTable } from "./google-sync.ts";
import { PopoverContent, ProjectsMenu } from "./Popovers.tsx";
import { ContextScreen, CharactersScreen, GlossaryScreen, ProjectScreen, SettingsScreen } from "./Reference.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { adoptText, checkRow, statusOf, toggleLock as toggleRowLock, visibleRows, type ViewFilters } from "./insights.ts";
import { clearActiveId, initializeLibrary, loadProject, readActiveId, readIndex, removeProject, saveProject, writeActiveId, type LibraryEntry } from "./library.ts";
import { editFinalText, recordFinalVersion, type MoriProject } from "./model.ts";
import { usePrefs } from "./prefs.ts";
import { useDraftAhead } from "./drafter.ts";
import { TermModal } from "./TermModal.tsx";
import { keyString, loadBindings, matchAction, saveBindings, type ActionId, type Bindings } from "./shortcuts.ts";
import { useProjectStore, type SaveState } from "./store.ts";
import { useUiLocalization } from "./ui-localization.ts";
import { forgetWorkspace, readWorkspace, writeWorkspace } from "./workspace-state.ts";
import { recoverPendingEdits } from "./recovery-journal.ts";

const DEFAULT_VIEW: ViewFilters = { filter: "all", query: "", speaker: "any", file: null, term: null };
const NO_ROWS: MoriProject["rows"] = [];
const NO_GLOSSARY: MoriProject["glossary"] = [];

/** Matches the translation editor. Only the active line mounts one. */
const editorSelector = "textarea[data-editor]";

export function MoriApp() {
  const { project, save, actions, load, restoreUnsaved, unload, forget } = useProjectStore();
  useUiLocalization(project);
  const { prefs, update: updatePrefs, setColumn } = usePrefs();
  const [bindings, setBindingsState] = useState<Bindings>(loadBindings);
  const [screen, setScreen] = useState<Screen>("matrix");
  // Optional copy/paste fallback; never replaces the normal Matrix workflow.
  const [matrixSplit, setMatrixSplit] = useState(() => localStorage.getItem("mori.matrix.side-by-side") === "true");
  const [splitWidth, setSplitWidth] = useState(46);
  useEffect(() => { localStorage.setItem("mori.matrix.side-by-side", String(matrixSplit)); }, [matrixSplit]);
  const [view, setViewState] = useState<ViewFilters>(DEFAULT_VIEW);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [pop, setPop] = useState<PopState | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [droppedFiles, setDroppedFiles] = useState<DroppedSource[] | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [library, setLibrary] = useState<LibraryEntry[]>(readIndex);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const capturingRef = useRef(false);
  const focusOnRender = useRef(false);
  const clickSelectionOnRender = useRef<EditorClickSelection | null>(null);
  const caretOnRender = useRef<number | null>(null);
  const bootStarted = useRef(false);
  const workspaceId = useRef<string | null>(null);

  const rows = project?.rows ?? NO_ROWS;
  const glossary = prefs.glossaryEnabled ? (project?.glossary ?? NO_GLOSSARY) : NO_GLOSSARY;

  const names = useMemo(() => new Map((prefs.charactersEnabled ? project?.characters ?? [] : []).map(c => [c.id, c.name])), [project, prefs.charactersEnabled]);
  const visible = useMemo(
    () => (project ? visibleRows(project.rows, prefs.charactersEnabled ? view : { ...view, speaker: "any" }, names, activeId, glossary) : []),
    [project, view, names, activeId, glossary, prefs.charactersEnabled],
  );
  const activeRow = rows.find(row => row.id === activeId) ?? null;
  const drafter = useDraftAhead(project, activeId, prefs, actions);

  const toast = useCallback((text: string) => { notify(text); }, []);

  const setView = useCallback((patch: Partial<ViewFilters>) => setViewState(current => ({ ...current, ...patch })), []);
  const go = useCallback((next: Screen) => {
    if ((next === "characters" && !prefs.charactersEnabled) || (next === "glossary" && !prefs.glossaryEnabled)) return;
    setScreen(next);
  }, [prefs.charactersEnabled, prefs.glossaryEnabled]);
  useEffect(() => {
    if (!prefs.charactersEnabled) {
      setViewState(current => current.speaker === "any" ? current : { ...current, speaker: "any" });
      if (screen === "characters") setScreen("matrix");
    }
    if (!prefs.glossaryEnabled && screen === "glossary") setScreen("matrix");
  }, [prefs.charactersEnabled, prefs.glossaryEnabled, screen]);
  // Pressing the same anchor again closes its popover, matching a toggle button.
  const openPop = useCallback((next: PopState) => setPop(current => current?.anchor === next.anchor ? null : next), []);
  const closePop = useCallback(() => setPop(null), []);
  const openModal = useCallback((next: ModalState) => {
    setPop(null);
    setModal(next);
  }, []);
  const closeModal = useCallback(() => { setModal(null); setDroppedFiles(null); }, []);
  useEffect(() => {
    const draggingFiles = (data: DataTransfer | null) => !!data?.types.includes("Files");
    const over = (event: DragEvent) => {
      if (!draggingFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      if (!modal) setFileDragOver(true);
    };
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget) setFileDragOver(false);
    };
    const drop = (event: DragEvent) => {
      if (!draggingFiles(event.dataTransfer)) return;
      event.preventDefault();
      setFileDragOver(false);
      if (!event.dataTransfer || (modal && modal.kind !== "import")) return;
      void droppedSources(event.dataTransfer).then(files => {
        if (!files.length) return;
        if (modal?.kind === "import") {
          window.dispatchEvent(new CustomEvent<DroppedSource[]>("mori:import-files", { detail: files }));
        } else {
          setDroppedFiles(files);
          setModal({ kind: "import", step: 1, add: !!project });
        }
      }).catch(error => toast(String(error)));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [modal, project, toast]);
  const toggleFold = useCallback((key: string) => {
    setFolded(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Restore the full editing position when opening a project, including after restart.
  const resetView = useCallback((next: MoriProject) => {
    const saved = readWorkspace(next.id);
    workspaceId.current = next.id;
    setViewState(saved.view && ["all", "todo", "draft", "translated", "locked", "warnings"].includes(saved.view.filter)
      ? { ...DEFAULT_VIEW, ...saved.view } : DEFAULT_VIEW);
    setActiveId(saved.activeId && next.rows.some(row => row.id === saved.activeId) ? saved.activeId : next.rows[0]?.id ?? null);
    setFolded(new Set(Array.isArray(saved.folded) ? saved.folded : []));
    setScreen(saved.screen && ["matrix", "characters", "glossary", "context", "project", "settings", "chatgpt"].includes(saved.screen) ? saved.screen : "matrix");
    setMatrixSplit(saved.matrixSplit === true);
    if (saved.columns && typeof saved.columns === "object") updatePrefs({ columns: saved.columns });
  }, [updatePrefs]);

  useEffect(() => {
    if (!project || workspaceId.current !== project.id) return;
    writeWorkspace(project.id, { screen, view, activeId, folded: [...folded], matrixSplit, columns: prefs.columns });
  }, [project?.id, screen, view, activeId, folded, matrixSplit, prefs.columns]);

  const select = useCallback((id: string, focus = false, clickSelection?: EditorClickSelection) => {
    setActiveId(id);
    if (focus) {
      focusOnRender.current = true;
      clickSelectionOnRender.current = clickSelection ?? null;
    }
  }, []);

  const step = useCallback((delta: 1 | -1) => {
    if (!visible.length) return;
    const index = visible.findIndex(row => row.id === activeId);
    const next = visible[Math.min(visible.length - 1, Math.max(0, index + delta))];
    if (next) select(next.id, true);
  }, [visible, activeId, select]);

  const adopt = (id: string, text: string, label: string) => {
    const row = rows.find(item => item.id === id);
    if (!row) return;
    if (row.isLocked) {
      toast("This line is locked. Unlock it first.");
      return;
    }
    if (row.final === text) return;
    actions.updateRow(id, current => adoptText(current, text));
    select(id, true);
    toast(`${label} used. Your previous text is in Versions.`);
  };

  const toggleLock = (id: string) => {
    const row = rows.find(item => item.id === id);
    if (!row) return;
    actions.updateRow(id, toggleRowLock);
    toast(row.isLocked ? `${id} unlocked` : `${id} locked as final`);
  };

  const insertToken = (token: string) => {
    if (!activeRow || activeRow.isLocked) return;
    const editor = document.querySelector<HTMLTextAreaElement>(editorSelector);
    const text = activeRow.final;
    const start = editor?.selectionStart ?? text.length;
    const end = editor?.selectionEnd ?? start;
    const next = text.slice(0, start) + token + text.slice(end);
    actions.updateRow(activeRow.id, current => editFinalText(current, next));
    caretOnRender.current = start + token.length;
    focusOnRender.current = true;
  };

  const keepNext = () => {
    if (!activeRow) return;
    actions.updateRow(activeRow.id, recordFinalVersion);
    const index = visible.findIndex(row => row.id === activeRow.id);
    const next = [...visible.slice(index + 1), ...visible.slice(0, Math.max(index, 0))]
      .find(row => !row.isLocked && statusOf(row) !== "translated");
    if (next) {
      select(next.id, true);
      toast(`Kept. Next unfinished: ${next.id}`);
    } else {
      toast("Nothing left to do in this view.");
    }
  };

  const runAction = (id: ActionId) => {
    switch (id) {
      case "next": step(1); break;
      case "prev": step(-1); break;
      case "keepNext": keepNext(); break;
      case "find": {
        if (screen !== "matrix") setScreen("matrix");
        requestAnimationFrame(() => {
          const input = document.getElementById("mori-find") as HTMLInputElement | null;
          input?.focus();
          input?.select();
        });
        break;
      }
      case "palette": openModal({ kind: "palette" }); break;
      case "useAI":
        if (activeRow?.ai) adopt(activeRow.id, activeRow.ai, "AI draft");
        else toast("No AI draft on this line.");
        break;
      case "useDev":
        if (activeRow?.legacy) adopt(activeRow.id, activeRow.legacy, "Dev draft");
        else toast("No dev draft on this line.");
        break;
      case "insertTok": {
        const missing = activeRow && checkRow(activeRow, glossary).find(warning => warning.kind === "missing-token");
        if (missing?.token) insertToken(missing.token);
        else toast("No missing placeholders.");
        break;
      }
      case "lock":
        if (activeRow) toggleLock(activeRow.id);
        break;
      case "speaker": {
        if (!prefs.charactersEnabled || !activeRow) break;
        const chip = document.querySelector<HTMLElement>(`[data-spk="${CSS.escape(activeRow.id)}"]`);
        if (!chip) toast("The speaker column is collapsed. Expand it to pick a speaker.");
        else openPop({ kind: "speaker", anchor: chip, rowId: activeRow.id, width: 290 });
        break;
      }
      case "inspector":
        updatePrefs({ inspectorOpen: !prefs.inspectorOpen });
        break;
      case "shortcuts": openModal({ kind: "shortcuts" }); break;
      case "newProject": openModal({ kind: "import", step: 1 }); break;
    }
  };

  // Keyboard flow. Reads the latest render's state through a ref so the listener is registered once.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (capturingRef.current) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
      const target = event.target;
      // Text fields keep their native Select All behavior; elsewhere only the current view is selectable.
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))) return;
      const content = modal ? document.querySelector(".overlay .modal")
        : pop ? document.querySelector(".pop")
        : screen === "matrix" ? document.querySelector(".matrix")
        : screen === "chatgpt" ? document.querySelector(".mori-ai-browser")
        : document.querySelector(".main .screen");
      event.preventDefault();
      if (content) {
        const range = document.createRange();
        range.selectNodeContents(content);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return;
    }
    if (event.key === "Escape") {
      if (pop) {
        event.preventDefault();
        closePop();
      } else if (modal) {
        event.preventDefault();
        closeModal();
      } else if (document.activeElement instanceof HTMLTextAreaElement && document.activeElement.dataset.editor !== undefined) {
        document.activeElement.blur();
      }
      return;
    }
    if (modal || !project) return;
    const binding = keyString(event);
    if (!binding) return;
    const id = matchAction(bindings, binding);
    if (!id) return;
    event.preventDefault();
    closePop();
    runAction(id);
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // Only moving to another line scrolls to it, so typing never fights the user's own scrolling.
  useLayoutEffect(() => {
    if (activeId) document.querySelector(`[data-row-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeId, screen]);

  // Focus and caret handling for the line that was just selected or edited.
  useLayoutEffect(() => {
    const editor = document.querySelector<HTMLTextAreaElement>(editorSelector);
    if (!editor) return;
    const insertedCaret = caretOnRender.current;
    if (insertedCaret !== null) {
      editor.setSelectionRange(insertedCaret, insertedCaret);
      caretOnRender.current = null;
    }
    if (focusOnRender.current) {
      focusOnRender.current = false;
      const selection = clickSelectionOnRender.current;
      clickSelectionOnRender.current = null;
      editor.focus();
      if (selection?.kind === "selectAll") editor.select();
      else {
        const offset = selection?.kind === "position" ? selection.offset : insertedCaret ?? editor.value.length;
        editor.setSelectionRange(offset, offset);
      }
    }
  });

  useEffect(() => {
    if (save.kind === "saved") setLibrary(readIndex());
  }, [save]);

  // Reopen only a previously selected project; fresh installs start empty.
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    void (async () => {
      try {
        await initializeLibrary();
        const entries = readIndex();
        const remembered = readActiveId();
        const id = entries.find(entry => entry.id === remembered)?.id;
        const opened = id ? await loadProject(id) : null;
        if (opened) {
          const recovered = recoverPendingEdits(opened);
          if (recovered) restoreUnsaved(recovered); else load(opened);
          writeActiveId(opened.id);
          resetView(recovered ?? opened);
        }
        setLibrary(readIndex());
      } catch (cause) {
        setBootError(cause instanceof Error ? cause.message : "The project store could not be opened.");
      } finally {
        setBooting(false);
      }
    })();
  }, [load, resetView]);

  const openProject = async (id: string) => {
    try {
      const next = await loadProject(id);
      if (!next) {
        toast("That project is no longer in this library.");
        return;
      }
      const recovered = recoverPendingEdits(next);
      if (recovered) restoreUnsaved(recovered); else load(next);
      writeActiveId(next.id);
      resetView(recovered ?? next);
      setPop(null);
      setLibrary(readIndex());
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "The project could not be opened.");
    }
  };

  const createProject = async (next: MoriProject) => {
    // Written before it is shown, so a failed save leaves the previous project in place and the wizard open.
    await saveProject(next);
    load(next);
    writeActiveId(next.id);
    resetView(next);
    setModal(null);
    setDroppedFiles(null);
    setLibrary(readIndex());
    toast(`“${next.name}” created. Opening the Matrix.`);
  };

  /** Files added to the open project go through the normal autosave queue, so no pending edit can overwrite them. */
  const appendToProject = async (next: MoriProject) => {
    const added = next.rows.length - (project?.rows.length ?? 0);
    actions.updateProject(() => next);
    setModal(null);
    setDroppedFiles(null);
    toast(added ? `Added ${added} line${added === 1 ? "" : "s"} to “${next.name}”.` : `Updated the saved files of “${next.name}”.`);
  };

  const deleteProject = async (id: string) => {
    forget(id);
    await removeProject(id);
    const entries = readIndex();
    setLibrary(entries);
    if (project?.id !== id) return;
    unload();
    workspaceId.current = null;
    forgetWorkspace(id);
    clearActiveId();
  };

  const value: AppValue | null = project ? {
    project,
    actions,
    save,
    library,
    prefs,
    setPrefs: updatePrefs,
    setColumn,
    bindings,
    setBindings: (next: Bindings) => {
      setBindingsState(next);
      saveBindings(next);
    },
    screen,
    go,
    view,
    setView,
    visible,
    activeId,
    activeRow,
    select,
    step,
    folded,
    toggleFold,
    pop,
    openPop,
    closePop,
    modal,
    openModal,
    closeModal,
    toast,
    adopt,
    toggleLock,
    insertToken,
    runAction,
    capturingRef,
    openProject,
    createProject,
    deleteProject,
    drafter,
    notice: noticeFor(save),
  } : null;

  if (!value) {
    return (
      <>
        <IconSprite />
        <div className="app">
          <header className="titlebar boot-titlebar">
            <div className="tb-left">Monku no Mori</div>
            <div className="tb-right"><WindowControls /></div>
          </header>
          {fileDragOver && <div className="mori-global-drop">Drop files to create a project</div>}
          <div className="body">
            <aside className="sidebar">
              <button type="button" className="proj" disabled={booting || !!bootError}
                onClick={event => openPop({ kind: "projects", anchor: event.currentTarget, width: 280 })}>
                <span className="pmark"><Icon name="folder" size="sm" /></span>
                <span className="pname">Select project</span>
                <Icon name="chevron-down" size="sm" />
              </button>
            </aside>
            <main className="boot">
              {booting ? (
                <div><b>Opening Mori</b>Loading your projects…</div>
              ) : (
                <div>
                  <b>{bootError ? "Mori can’t open its project store" : "No project selected"}</b>
                  {bootError ?? "Choose a project from the top left, or drop files or folders anywhere to import."}
                  <br />
                  <button type="button" className="btn primary" onClick={() => openModal({ kind: "import", step: 1 })}>New project</button>
                </div>
              )}
            </main>
          </div>
        </div>
        {pop?.kind === "projects" && <PopoverFrame anchor={pop.anchor} width={pop.width} onClose={closePop}>
          <ProjectsMenu currentId={null} library={library} openProject={openProject}
            newProject={() => openModal({ kind: "import", step: 1 })} closePop={closePop} toast={toast} />
        </PopoverFrame>}
        {modal?.kind === "import" && <ImportModal step={modal.step} tables={modal.tables} initialFiles={droppedFiles} onClose={closeModal} onCreate={createProject} onAppend={appendToProject} />}
        <NotificationViewport />
      </>
    );
  }

  const workspace = screen === "matrix" ? <MatrixScreen sideBySide={matrixSplit} onToggleSideBySide={() => setMatrixSplit(value => !value)} />
    : screen === "characters" && prefs.charactersEnabled ? <CharactersScreen />
    : screen === "glossary" && prefs.glossaryEnabled ? <GlossaryScreen />
    : screen === "context" ? <ContextScreen />
    : screen === "project" ? <ProjectScreen key={value.project.id} />
    : screen === "chatgpt" ? null : <SettingsScreen />;

  return (
    <AppContext.Provider value={value}>
      <IconSprite />
      <div className="app">
        <Titlebar />
        {fileDragOver && <div className="mori-global-drop">Drop files to add to {value.project.name}</div>}
        <div className="body">
          <Sidebar />
          <main className={`main${screen === "matrix" && matrixSplit ? " mori-matrix-split" : ""}${screen === "chatgpt" ? " mori-chat-full" : ""}`}
            style={screen === "matrix" && matrixSplit ? { gridTemplateColumns: `minmax(0, ${100 - splitWidth}fr) 8px minmax(0, ${splitWidth}fr)` } : undefined}>
            <div className="mori-workspace">
              {value.notice && <div className="notice" role="alert">{value.notice}</div>}
              {workspace}
            </div>
            {screen === "matrix" && matrixSplit && <div className="matrix-split-divider" role="separator" tabIndex={0}
              aria-label="Resize Matrix and ChatGPT panes" aria-orientation="vertical"
              aria-valuemin={30} aria-valuemax={55} aria-valuenow={splitWidth}
              title="Drag to resize; use arrow keys when focused"
              onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
              onPointerMove={event => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
                if (bounds) setSplitWidth(Math.max(30, Math.min(55, 100 * (bounds.right - event.clientX) / bounds.width)));
              }}
              onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
              onKeyDown={event => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setSplitWidth(width => Math.max(30, Math.min(55, width + (event.key === "ArrowLeft" ? 3 : -3))));
              }} />}
            <div className="mori-persistent-chat">
              <ChatGPTScreen compact={screen === "matrix" && matrixSplit} />
            </div>
          </main>
        </div>
        <StatusBar />
      </div>
      {pop && (
        <PopoverFrame anchor={pop.anchor} align={pop.align} width={pop.width} onClose={closePop}>
          <PopoverContent kind={pop.kind} rowId={pop.rowId} />
        </PopoverFrame>
      )}
      {modal && modal.kind === "shortcuts" && <Modal onClose={closeModal} className="narrow"><ShortcutsModal /></Modal>}
      {modal && modal.kind === "palette" && <Modal onClose={closeModal} className="pal"><PaletteModal /></Modal>}
      {modal && modal.kind === "templates" && <Modal onClose={closeModal} className="narrow"><TemplatesModal /></Modal>}
      {modal && modal.kind === "term" && <Modal onClose={closeModal} className="term-modal"><TermModal {...modal} /></Modal>}
      {modal && modal.kind === "import" && <ImportModal step={modal.step} tables={modal.tables} initialFiles={droppedFiles} current={modal.add ? project : null} onClose={closeModal} onCreate={createProject} onAppend={appendToProject} />}
      <NotificationViewport />
    </AppContext.Provider>
  );
}

function ImportModal({ step, tables, initialFiles, current, onClose, onCreate, onAppend }: {
  step: 1 | 2 | 3;
  tables?: GoogleStagedTable[] | undefined;
  initialFiles?: DroppedSource[] | null | undefined;
  current?: MoriProject | null | undefined;
  onClose: () => void;
  onCreate: (project: MoriProject) => Promise<void>;
  onAppend: (project: MoriProject) => Promise<void>;
}) {
  return (
    <Modal onClose={onClose} className="wide">
      <ImportWizard initialStep={step} initialTables={tables} initialFiles={initialFiles ?? undefined} current={current} onClose={onClose} onCreate={onCreate} onAppend={onAppend} />
    </Modal>
  );
}

function noticeFor(save: SaveState): string | null {
  return save.kind === "error" ? `Changes couldn’t be saved in this browser (${save.message}). They stay on screen and will retry.` : null;
}
