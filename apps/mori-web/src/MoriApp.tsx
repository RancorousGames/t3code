import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppContext, type AppValue, type ModalState, type PopState, type Screen } from "./app-context.ts";
import { StatusBar, Titlebar } from "./Chrome.tsx";
import { ChatGPTScreen } from "./ChatGPTScreen.tsx";
import { ShortcutsModal, PaletteModal, TemplatesModal } from "./Dialogs.tsx";
import { FocusScreen } from "./Focus.tsx";
import { ImportWizard } from "./ImportWizard.tsx";
import { IconSprite } from "./Icons.tsx";
import { Inspector } from "./Inspector.tsx";
import { MatrixScreen } from "./Matrix.tsx";
import { Modal, PopoverFrame, Toast } from "./Overlays.tsx";
import { PopoverContent } from "./Popovers.tsx";
import { ContextScreen, CharactersScreen, GlossaryScreen, ProjectScreen, SettingsScreen } from "./Reference.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { adoptText, checkRow, statusOf, toggleLock as toggleRowLock, visibleRows, type ViewFilters } from "./insights.ts";
import { clearActiveId, hasSeededDemo, initializeLibrary, loadProject, markSeededDemo, readActiveId, readIndex, removeProject, saveProject, writeActiveId, type LibraryEntry } from "./library.ts";
import { editFinalText, recordFinalVersion, type MoriProject } from "./model.ts";
import { usePrefs } from "./prefs.ts";
import { createSampleProject } from "./sampleProject.ts";
import { keyString, loadBindings, matchAction, saveBindings, type ActionId, type Bindings } from "./shortcuts.ts";
import { useProjectStore, type SaveState } from "./store.ts";

const DEFAULT_VIEW: ViewFilters = { filter: "all", query: "", speaker: "any", file: null };
const TOAST_MS = 2600;

const NO_ROWS: MoriProject["rows"] = [];

/** Matches the translation editor. Only the active line mounts one. */
const editorSelector = "textarea[data-editor]";

export function MoriApp() {
  const { project, save, actions, load, unload, forget } = useProjectStore();
  const { prefs, update: updatePrefs, setColumn } = usePrefs();
  const [bindings, setBindingsState] = useState<Bindings>(loadBindings);
  const [screen, setScreen] = useState<Screen>("matrix");
  const [view, setViewState] = useState<ViewFilters>(DEFAULT_VIEW);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [pop, setPop] = useState<PopState | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>(readIndex);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const capturingRef = useRef(false);
  const focusOnRender = useRef(false);
  const caretOnRender = useRef<number | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const bootStarted = useRef(false);

  const rows = project?.rows ?? NO_ROWS;
  const glossary = useMemo(() => project?.glossary ?? [], [project]);

  const names = useMemo(() => new Map((project?.characters ?? []).map(c => [c.id, c.name])), [project]);
  const visible = useMemo(
    () => (project ? visibleRows(project.rows, view, names, activeId, project.glossary) : []),
    [project, view, names, activeId],
  );
  const activeRow = rows.find(row => row.id === activeId) ?? null;

  const toast = useCallback((text: string) => {
    setMessage(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setMessage(null), TOAST_MS);
  }, []);

  const setView = useCallback((patch: Partial<ViewFilters>) => setViewState(current => ({ ...current, ...patch })), []);
  // Pressing the same anchor again closes its popover, matching a toggle button.
  const openPop = useCallback((next: PopState) => setPop(current => current?.anchor === next.anchor ? null : next), []);
  const closePop = useCallback(() => setPop(null), []);
  const openModal = useCallback((next: ModalState) => {
    setPop(null);
    setModal(next);
  }, []);
  const closeModal = useCallback(() => setModal(null), []);
  const toggleFold = useCallback((key: string) => {
    setFolded(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const resetView = useCallback((next: MoriProject) => {
    setViewState(DEFAULT_VIEW);
    setActiveId(next.rows[0]?.id ?? null);
    setFolded(new Set());
    setScreen("matrix");
  }, []);

  const select = useCallback((id: string, focus = false) => {
    setActiveId(id);
    if (focus) focusOnRender.current = true;
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
        if (!activeRow) break;
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
    if (caretOnRender.current !== null) {
      editor.setSelectionRange(caretOnRender.current, caretOnRender.current);
      caretOnRender.current = null;
    }
    if (focusOnRender.current) {
      focusOnRender.current = false;
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    }
  });

  useEffect(() => {
    if (save.kind === "saved") setLibrary(readIndex());
  }, [save]);

  // Opening the app: load the last project, or write the demo on first launch.
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    void (async () => {
      try {
        await initializeLibrary();
        if (!readIndex().length && !hasSeededDemo()) {
          const demo = createSampleProject();
          // Keep a stored copy if one exists, so an emptied index can't overwrite edits to it.
          await saveProject((await loadProject(demo.id)) ?? demo);
          markSeededDemo();
        }
        const entries = readIndex();
        const remembered = readActiveId();
        const id = entries.find(entry => entry.id === remembered)?.id ?? entries[0]?.id;
        const opened = id ? await loadProject(id) : null;
        if (opened) {
          load(opened);
          writeActiveId(opened.id);
          resetView(opened);
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
      load(next);
      writeActiveId(next.id);
      resetView(next);
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
    setLibrary(readIndex());
    toast(`“${next.name}” created. Opening the Matrix.`);
  };

  const deleteProject = async (id: string) => {
    forget(id);
    await removeProject(id);
    const entries = readIndex();
    setLibrary(entries);
    if (project?.id !== id) return;
    const next = entries[0] ? await loadProject(entries[0].id) : null;
    if (next) {
      load(next);
      writeActiveId(next.id);
      resetView(next);
    } else {
      unload();
      clearActiveId();
    }
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
    go: setScreen,
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
    notice: noticeFor(save),
  } : null;

  if (!value) {
    return (
      <>
        <IconSprite />
        <div className="app">
          <div className="boot">
            {booting ? (
              <div><b>Opening Mori</b>Loading your projects…</div>
            ) : (
              <div>
                <b>{bootError ? "Mori can’t open its project store" : "No projects yet"}</b>
                {bootError ?? "Start one from your files, or a public Google Sheets link."}
                <br />
                <button type="button" className="btn primary" onClick={() => openModal({ kind: "import", step: 1 })}>New project</button>
              </div>
            )}
          </div>
        </div>
        {modal?.kind === "import" && <ImportModal step={modal.step} onClose={closeModal} onCreate={createProject} />}
      </>
    );
  }

  const workspace = screen === "matrix" ? <MatrixScreen />
    : screen === "focus" ? <FocusScreen />
    : screen === "characters" ? <CharactersScreen />
    : screen === "glossary" ? <GlossaryScreen />
    : screen === "context" ? <ContextScreen />
    : screen === "chatgpt" ? <ChatGPTScreen />
    : screen === "project" ? <ProjectScreen />
    : <SettingsScreen />;

  return (
    <AppContext.Provider value={value}>
      <IconSprite />
      <div className="app">
        <Titlebar />
        <div className="body">
          <Sidebar />
          <main className="main">
            {value.notice && <div className="notice" role="alert">{value.notice}</div>}
            {workspace}
          </main>
          {screen === "matrix" && prefs.inspectorOpen && <Inspector />}
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
      {modal && modal.kind === "import" && <ImportModal step={modal.step} onClose={closeModal} onCreate={createProject} />}
      <Toast message={message} />
    </AppContext.Provider>
  );
}

function ImportModal({ step, onClose, onCreate }: {
  step: 1 | 2 | 3;
  onClose: () => void;
  onCreate: (project: MoriProject) => Promise<void>;
}) {
  return (
    <Modal onClose={onClose} className="wide">
      <ImportWizard initialStep={step} onClose={onClose} onCreate={onCreate} />
    </Modal>
  );
}

function noticeFor(save: SaveState): string | null {
  return save.kind === "error" ? `Changes couldn’t be saved in this browser (${save.message}). They stay on screen and will retry.` : null;
}
