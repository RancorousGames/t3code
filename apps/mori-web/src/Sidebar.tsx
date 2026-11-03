import { useLayoutEffect, useRef, useState } from "react";
import { useApp, type Screen } from "./app-context.ts";
import { tr } from "./ui-localization.ts";
import { Icon } from "./Icons.tsx";
import { statusOf, checkRow } from "./insights.ts";
import type { MoriProject } from "./model.ts";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]?.toUpperCase() ?? "").join("");

function ProjectName({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(13.5);

  useLayoutEffect(() => {
    const element = ref.current;
    const context = document.createElement("canvas").getContext("2d");
    if (!element || !context) return;
    const fit = () => {
      const style = getComputedStyle(element);
      context.font = `${style.fontWeight} 13.5px ${style.fontFamily}`;
      const textWidth = context.measureText(name).width;
      if (!textWidth || !element.clientWidth) return;
      const next = Math.min(13.5, Math.max(11, 13.5 * element.clientWidth / textWidth));
      setFontSize(current => Math.abs(current - next) < 0.1 ? current : next);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, [name]);

  return <span ref={ref} className="pname" style={{ display: "block", fontSize, whiteSpace: "normal", overflow: "visible", overflowWrap: "anywhere", textOverflow: "clip", lineHeight: 1.25 }}>{name}</span>;
}

/** Folder part of a source path: "dialogue/chapter1.json" is in "dialogue". */
const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const fileOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function Ring({ done, total }: { done: number; total: number }) {
  const circumference = 2 * Math.PI * 5;
  const fraction = total ? done / total : 0;
  return (
    <svg className="ring" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="5" fill="none" stroke="rgba(196,226,206,.12)" strokeWidth="2" />
      <circle
        cx="7" cy="7" r="5" fill="none"
        stroke={fraction === 1 ? "#8ccfa7" : "#62ad86"}
        strokeWidth="2"
        strokeDasharray={`${circumference * fraction} ${circumference}`}
        transform="rotate(-90 7 7)"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Sidebar() {
  const { project, screen, go, view, setView, openPop, openModal, prefs, setPrefs } = useApp();
  const rows = project.rows;
  const translated = rows.filter(row => statusOf(row) === "translated").length;
  const drafts = rows.filter(row => statusOf(row) === "draft").length;
  const todo = rows.filter(row => !row.isLocked && statusOf(row) !== "translated").length;
  const warnings = rows.filter(row => checkRow(row, prefs.glossaryEnabled ? project.glossary : []).length > 0).length;
  const percent = rows.length ? Math.round(100 * translated / rows.length) : 0;
  const folders = groupFiles(project);

  const showScreen = (next: Screen) => go(next);
  const navClass = (active: boolean) => `ni${active ? " active" : ""}`;
  const onMatrix = screen === "matrix";

  return (
    <aside className="sidebar">
      <button type="button" className="proj" onClick={event => openPop({ kind: "projects", anchor: event.currentTarget, width: 280 })}>
        <span className="pmark">{initials(project.name)}</span>
        <span style={{ minWidth: 0 }}>
          <ProjectName name={project.name} />
        </span>
        <Icon name="chevron-down" size="sm" />
        <span className="proj-prog">
          <span className="bar-l"><span>{percent}% {tr("Translated")}</span><span className="tabnum">{translated} / {rows.length}</span></span>
          <span className="bar">
            <span style={{ width: `${rows.length ? 100 * translated / rows.length : 0}%`, background: "var(--moss)" }} />
            <span style={{ width: `${rows.length ? 100 * drafts / rows.length : 0}%`, background: "var(--mist)", opacity: 0.45 }} />
          </span>
        </span>
      </button>

      <nav className="nav" aria-label="Project">
        <div className="nav-label">{tr("Translate")}</div>
        <button type="button" className={navClass(onMatrix && view.filter !== "warnings")} onClick={() => { setView({ filter: "all", file: view.file }); showScreen("matrix"); }}>
          <Icon name="table" />{tr("Matrix")}<span className="count tabnum">{todo} to do</span>
        </button>
        <button type="button" className={navClass(screen === "focus")} onClick={() => showScreen("focus")}>
          <Icon name="target" />Focus
        </button>
        <button type="button" className={navClass(onMatrix && view.filter === "warnings")} onClick={() => { setView({ filter: "warnings" }); showScreen("matrix"); }}>
          <Icon name="review" />{tr("Review")}<span className={`count warn tabnum`}>{warnings || ""}</span>
        </button>

        <div className="nav-label">{tr("AI assistance")}</div>
        <button type="button" className={navClass(screen === "chatgpt")} onClick={() => showScreen("chatgpt")}>
          <Icon name="sparkle" />{tr("AI Chats")}
        </button>

        <div className="nav-label">{tr("Reference")}</div>
        {prefs.charactersEnabled && <button type="button" className={navClass(screen === "characters")} onClick={() => showScreen("characters")}>
          <Icon name="users" />{tr("Characters")}<span className="count">{project.characters.length}</span>
        </button>}
        {prefs.glossaryEnabled && <button type="button" className={navClass(screen === "glossary")} onClick={() => showScreen("glossary")}>
          <Icon name="book" />{tr("Glossary")}<span className="count">{project.glossary.length}</span>
        </button>}
        <button type="button" className={navClass(screen === "context")} onClick={() => showScreen("context")}>
          <Icon name="scroll" />{tr("Context")}
        </button>
        <button type="button" className={navClass(screen === "project")} onClick={() => showScreen("project")}>
          <Icon name="folder" />{tr("Project & files")}
        </button>

        <div className="nav-label">
          <button type="button" className="files-toggle" aria-expanded={prefs.filesExpanded} aria-controls="mori-sidebar-files" onClick={() => setPrefs({ filesExpanded: !prefs.filesExpanded })}>
            <Icon name="chevron-down" size="xs" className="files-chev" />{tr("Files")}
          </button>
          <button type="button" title="Import files into a new project" aria-label="Import files into a new project" onClick={() => { setPrefs({ filesExpanded: true }); openModal({ kind: "import", step: 1 }); }}>
            <Icon name="plus" size="xs" />
          </button>
        </div>
        <div id="mori-sidebar-files" hidden={!prefs.filesExpanded}>
        {prefs.filesExpanded && folders.map(folder => (
          <div key={folder.name || "root"}>
            <div className="folder"><Icon name="folder" size="sm" />{folder.name || "(top level)"}</div>
            {folder.files.map(file => {
              const lines = rows.filter(row => row.sourceFile === file.path);
              const done = lines.filter(row => statusOf(row) === "translated").length;
              const active = view.file === file.path;
              return (
                <button
                  type="button"
                  key={file.path}
                  className={`fi${active ? " active" : ""}`}
                  title={file.path}
                  onClick={() => { setView({ file: active ? null : file.path }); showScreen("matrix"); }}
                >
                  <Ring done={done} total={lines.length} />
                  <span className="n">{fileOf(file.path)}</span>
                  <span className="c tabnum">{done}/{lines.length}</span>
                </button>
              );
            })}
          </div>
        ))}
        {prefs.filesExpanded && !folders.length && <p className="muted" style={{ padding: "6px 8px", fontSize: 12 }}>No source files yet.</p>}
        </div>
      </nav>

      <div className="side-foot">
        <button type="button" className="ni" onClick={event => openPop({ kind: "templates", anchor: event.currentTarget, width: 320, align: "right" })}>
          <Icon name="layers" />{tr("Templates")}
        </button>
        <button type="button" className={navClass(screen === "settings")} onClick={() => showScreen("settings")}>
          <Icon name="sliders" />{tr("Settings")}
        </button>
      </div>
    </aside>
  );
}

/** Files grouped by folder, in the order the project lists them. */
function groupFiles(project: MoriProject): { name: string; files: { path: string }[] }[] {
  const paths = [...new Set([...project.sourceFiles ?? [], ...project.rows.map(row => row.sourceFile).filter((p): p is string => !!p)])];
  const folders = new Map<string, { path: string }[]>();
  for (const path of paths) {
    const folder = folderOf(path);
    folders.set(folder, [...(folders.get(folder) ?? []), { path }]);
  }
  return [...folders].map(([name, files]) => ({ name, files }));
}
