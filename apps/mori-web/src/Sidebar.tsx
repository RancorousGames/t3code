import { useApp, type Screen } from "./app-context.ts";
import { Icon } from "./Icons.tsx";
import { statusOf, checkRow } from "./insights.ts";
import type { MoriProject } from "./model.ts";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]?.toUpperCase() ?? "").join("");

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
  const { project, screen, go, view, setView, openPop, openModal } = useApp();
  const rows = project.rows;
  const translated = rows.filter(row => statusOf(row) === "translated").length;
  const drafts = rows.filter(row => statusOf(row) === "draft").length;
  const todo = rows.filter(row => !row.isLocked && statusOf(row) !== "translated").length;
  const warnings = rows.filter(row => checkRow(row, project.glossary).length > 0).length;
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
          <span className="pname" style={{ display: "block" }}>{project.name}</span>
          <span className="pmeta" style={{ display: "block" }}>EN → JA · {rows.length} lines</span>
        </span>
        <Icon name="chevron-down" size="sm" />
        <span className="proj-prog">
          <span className="bar-l"><span>{percent}% translated</span><span className="tabnum">{translated} / {rows.length}</span></span>
          <span className="bar">
            <span style={{ width: `${rows.length ? 100 * translated / rows.length : 0}%`, background: "var(--moss)" }} />
            <span style={{ width: `${rows.length ? 100 * drafts / rows.length : 0}%`, background: "var(--mist)", opacity: 0.45 }} />
          </span>
        </span>
      </button>

      <nav className="nav" aria-label="Project">
        <div className="nav-label">Translate</div>
        <button type="button" className={navClass(onMatrix && view.filter !== "warnings")} onClick={() => { setView({ filter: "all", file: view.file }); showScreen("matrix"); }}>
          <Icon name="table" />Matrix<span className="count tabnum">{todo} to do</span>
        </button>
        <button type="button" className={navClass(screen === "focus")} onClick={() => showScreen("focus")}>
          <Icon name="target" />Focus
        </button>
        <button type="button" className={navClass(onMatrix && view.filter === "warnings")} onClick={() => { setView({ filter: "warnings" }); showScreen("matrix"); }}>
          <Icon name="review" />Review<span className={`count warn tabnum`}>{warnings || ""}</span>
        </button>

        <div className="nav-label">AI assistance</div>
        <button type="button" className={navClass(screen === "chatgpt")} onClick={() => showScreen("chatgpt")}>
          <Icon name="sparkle" />ChatGPT chats
        </button>

        <div className="nav-label">Reference</div>
        <button type="button" className={navClass(screen === "characters")} onClick={() => showScreen("characters")}>
          <Icon name="users" />Characters<span className="count">{project.characters.length}</span>
        </button>
        <button type="button" className={navClass(screen === "glossary")} onClick={() => showScreen("glossary")}>
          <Icon name="book" />Glossary<span className="count">{project.glossary.length}</span>
        </button>
        <button type="button" className={navClass(screen === "context")} onClick={() => showScreen("context")}>
          <Icon name="scroll" />Context
        </button>
        <button type="button" className={navClass(screen === "project")} onClick={() => showScreen("project")}>
          <Icon name="folder" />Project &amp; files
        </button>

        <div className="nav-label">
          Files
          <button type="button" title="Import files into a new project" aria-label="Import files into a new project" onClick={() => openModal({ kind: "import", step: 1 })}>
            <Icon name="plus" size="xs" />
          </button>
        </div>
        {folders.map(folder => (
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
        {!folders.length && <p className="muted" style={{ padding: "6px 8px", fontSize: 12 }}>No source files yet.</p>}
      </nav>

      <div className="side-foot">
        <button type="button" className="ni" onClick={event => openPop({ kind: "templates", anchor: event.currentTarget, width: 320, align: "right" })}>
          <Icon name="layers" />Templates
        </button>
        <button type="button" className={navClass(screen === "settings")} onClick={() => showScreen("settings")}>
          <Icon name="sliders" />Settings
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
