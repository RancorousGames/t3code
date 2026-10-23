import { useState, type ReactNode } from "react";
import { useApp } from "./app-context.ts";
import { Icon } from "./Icons.tsx";
import { findUsages, statusOf } from "./insights.ts";
import { JA_FONTS, DEFAULT_COLUMN_PREFS } from "./prefs.ts";
import { newTemplateId, readTemplates, writeTemplates } from "./templates.ts";
import { characterColor, cssVar } from "./theme.ts";
import type { MoriProject } from "./model.ts";
import { nativeMori } from "./backend.ts";
import { listProjectRevisions, restoreProjectRevision } from "./library.ts";
import { GoogleSyncPanel } from "./GoogleSyncPanel.tsx";
import { GoogleConnect } from "./GoogleConnect.tsx";
import { browserDownload, buildInterchangeExport, type ExportFormat, type TranslationMode } from "./exporters.ts";

function ScreenHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="screen-h">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <span className="grow" />
      {children}
    </div>
  );
}

export function CharactersScreen() {
  const { project, actions, toast } = useApp();
  const [picked, setPicked] = useState<string | null>(null);
  const character = project.characters.find(c => c.id === picked) ?? project.characters[0] ?? null;
  const lines = character ? project.rows.filter(row => row.characterId === character.id).length : 0;

  const add = () => {
    const id = actions.addCharacter({ name: "New character" });
    setPicked(id);
  };
  const remove = () => {
    if (!character) return;
    if (!window.confirm(`Delete “${character.name}”? The ${lines} line${lines === 1 ? "" : "s"} spoken by them become unassigned.`)) return;
    actions.removeCharacter(character.id);
    setPicked(null);
    toast(`Deleted “${character.name}”.`);
  };
  const saveTemplate = () => {
    if (!character) return;
    writeTemplates([...readTemplates(), {
      kind: "character", id: newTemplateId(), name: character.name,
      role: character.role, tone: character.tone, description: character.description,
    }]);
    toast(`Saved “${character.name}” as a template.`);
  };

  return (
    <div className="screen">
      <ScreenHeader title="Characters" description="Who speaks, how they talk. Every line by a character uses these notes.">
        <button type="button" className="btn outline sm" onClick={add}><Icon name="plus" size="sm" />New character</button>
      </ScreenHeader>
      <div className="split">
        <div className="list">
          {project.characters.map(c => {
            const count = project.rows.filter(row => row.characterId === c.id).length;
            return (
              <button key={c.id} type="button" className={`list-item${character?.id === c.id ? " active" : ""}`} onClick={() => setPicked(c.id)}>
                <span className="avl" style={cssVar("--c", characterColor(c.id))}>{c.name.charAt(0)}</span>
                <span className="opt-t"><span>{c.name}</span><span className="sub">{c.role || "No role yet"}</span></span>
                <span className="sub tabnum">{count}</span>
              </button>
            );
          })}
          {project.characters.length === 0 && <p className="muted" style={{ padding: 10, fontSize: 12.5 }}>No characters yet.</p>}
        </div>
        {character ? (
          <div className="panel">
            <div className="grid2">
              <label className="field-l">Name
                <input value={character.name} onChange={event => actions.updateCharacter(character.id, { name: event.target.value })} />
              </label>
              <label className="field-l">Role
                <input value={character.role} onChange={event => actions.updateCharacter(character.id, { role: event.target.value })} />
              </label>
            </div>
            <label className="field-l">Tone
              <input value={character.tone} placeholder="casual · 17 y/o" onChange={event => actions.updateCharacter(character.id, { tone: event.target.value })} />
            </label>
            <label className="field-l">Voice notes
              <textarea
                className="ja"
                value={character.description}
                placeholder="一人称、語尾、呼び方など"
                onChange={event => actions.updateCharacter(character.id, { description: event.target.value })}
              />
            </label>
            <p className="muted" style={{ fontSize: 12 }}>{lines} line{lines === 1 ? "" : "s"} spoken by {character.name}.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn outline sm" onClick={saveTemplate}><Icon name="layers" size="sm" />Save as template</button>
              <span className="grow" />
              <button type="button" className="btn sm danger" onClick={remove}><Icon name="x" size="sm" />Delete character</button>
            </div>
          </div>
        ) : (
          <p className="muted">Add a character to start.</p>
        )}
      </div>
    </div>
  );
}

export function GlossaryScreen() {
  const { project, actions, toast } = useApp();
  const addTerm = () => actions.addGlossary({ en: "", jp: "", explanation: "" });
  const saveTemplate = () => {
    const terms = project.glossary.filter(term => term.en.trim());
    if (!terms.length) {
      toast("Add a term before saving the glossary as a template.");
      return;
    }
    const name = window.prompt("Name this glossary template", "Glossary");
    if (!name?.trim()) return;
    writeTemplates([...readTemplates(), {
      kind: "glossary", id: newTemplateId(), name: name.trim(),
      terms: terms.map(term => ({ en: term.en, jp: term.jp, explanation: term.explanation })),
    }]);
    toast(`Saved “${name.trim()}” as a glossary template.`);
  };

  return (
    <div className="screen">
      <ScreenHeader title="Glossary" description="Terms that must stay consistent. Lines that use a term are underlined in the Matrix and checked.">
        <button type="button" className="btn outline sm" onClick={saveTemplate}><Icon name="layers" size="sm" />Save as template</button>
        <button type="button" className="btn outline sm" onClick={addTerm}><Icon name="plus" size="sm" />Add term</button>
      </ScreenHeader>
      <table className="gl-table">
        <thead>
          <tr><th style={{ width: "24%" }}>English</th><th style={{ width: "24%" }}>Japanese</th><th>Note</th><th style={{ width: 80 }}>Lines</th><th style={{ width: 40 }} /></tr>
        </thead>
        <tbody>
          {project.glossary.map(term => {
            const usage = findUsages(project.rows, term.en).total;
            return (
              <tr key={term.id}>
                <td><input value={term.en} aria-label="English term" onChange={event => actions.updateGlossary(term.id, { en: event.target.value })} /></td>
                <td><input className="ja" value={term.jp} aria-label="Japanese term" onChange={event => actions.updateGlossary(term.id, { jp: event.target.value })} /></td>
                <td><input value={term.explanation} aria-label="Note" onChange={event => actions.updateGlossary(term.id, { explanation: event.target.value })} /></td>
                <td className="tabnum muted">{usage}</td>
                <td>
                  <button type="button" className="ib" aria-label="Delete term" onClick={() => actions.removeGlossary(term.id)}>
                    <Icon name="x" size="sm" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {project.glossary.length === 0 && <p className="muted" style={{ marginTop: 14, fontSize: 12.5 }}>No terms yet.</p>}
    </div>
  );
}

export function ContextScreen() {
  const { project, actions, toast } = useApp();
  const saveTemplate = () => {
    const name = window.prompt("Name this context template", "Project context");
    if (!name?.trim()) return;
    writeTemplates([...readTemplates(), {
      kind: "context", id: newTemplateId(), name: name.trim(),
      global: project.context.global, project: project.context.project,
    }]);
    toast(`Saved “${name.trim()}” as a template.`);
  };
  return (
    <div className="screen">
      <ScreenHeader title="Context" description="Rules the translation should follow. Global rules are for every project; project rules are for this one.">
        <button type="button" className="btn outline sm" onClick={saveTemplate}><Icon name="layers" size="sm" />Save as template</button>
      </ScreenHeader>
      <div className="split" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
        <div className="panel">
          <label className="field-l">Global rules
            <textarea value={project.context.global} onChange={event => actions.setContext("global", event.target.value)} />
          </label>
        </div>
        <div className="panel">
          <label className="field-l">This project
            <textarea value={project.context.project} onChange={event => actions.setContext("project", event.target.value)} />
          </label>
        </div>
      </div>
    </div>
  );
}

/** Export the full project, including translation versions and context. */
function downloadProject(project: MoriProject) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${project.name.replace(/[^a-z0-9-_]+/gi, "_") || "project"}.mori`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ProjectScreen() {
  const { project, actions, deleteProject, toast, save, setView, go } = useApp();
  const rows = project.rows;
  const translated = rows.filter(row => statusOf(row) === "translated").length;
  const drafts = rows.filter(row => statusOf(row) === "draft").length;
  const locked = rows.filter(row => row.isLocked).length;
  const files = [...new Set([...project.sourceFiles ?? [], ...rows.map(row => row.sourceFile ?? "")])].filter(Boolean);
  const [revisions, setRevisions] = useState<{ id: string; at: number }[] | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv");
  const [exportMode, setExportMode] = useState<TranslationMode>("curated");
  const exportInterchange = async () => {
    const report = buildInterchangeExport(project, exportFormat, exportMode);
    if (report.empty || report.warnings.length) {
      const reply = window.confirm(`${report.filled}/${report.total} lines have output text; ${report.empty} empty, ${report.warnings.length} quality warnings. Export anyway? This is a normalized table, not the original file structure.`);
      if (!reply) return;
    }
    try {
      const native = nativeMori();
      if (native) {
        const saved = await native.exportInterchange(report);
        if (saved) toast(`Exported ${saved.filename}.`);
      } else browserDownload(report);
    } catch (cause) { toast(cause instanceof Error ? cause.message : "Export failed."); }
  };
  const exportBackup = async () => {
    try {
      const native = nativeMori();
      if (!native) downloadProject(project);
      else {
        const saved = await native.saveProjectBackup(project);
        if (saved) toast(`Saved ${saved.filename}.`);
      }
    } catch (cause) { toast(cause instanceof Error ? cause.message : "Export failed."); }
  };
  const fetchRevisions = async () => {
    try { setRevisions(await listProjectRevisions(project.id)); }
    catch (cause) { toast(cause instanceof Error ? cause.message : "Cannot load revisions."); }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${project.name}” from this library? You can recover a recent desktop backup, but please also export a .mori copy first.`)) return;
    try {
      await deleteProject(project.id);
      toast("Project deleted.");
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "The project couldn’t be deleted.");
    }
  };

  return (
    <div className="screen">
      <ScreenHeader title="Project & files" description="What this project holds and where it is kept.">
        <button type="button" className="btn outline sm" onClick={() => void exportBackup()}><Icon name="download" size="sm" />Export .mori backup</button>
      </ScreenHeader>
      <div className="panel" style={{ marginBottom: 18 }}>
        <h3>Localized interchange export</h3>
        <p className="muted" style={{ fontSize: 12 }}>Exports a normalized EN→JA table. It does not recreate the original spreadsheet, DOCX, code file or nested JSON. Source files are never modified.</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select className="sel" aria-label="Export format" value={exportFormat} onChange={event => setExportFormat(event.target.value as ExportFormat)}>
            <option value="csv">CSV (Excel-friendly)</option><option value="json">JSON interchange</option><option value="po">Gettext PO</option>
          </select>
          <select className="sel" aria-label="Translation source" value={exportMode} onChange={event => setExportMode(event.target.value as TranslationMode)}>
            <option value="curated">Curated text only</option><option value="curated-or-draft">Use AI/dev draft when not curated (review carefully)</option>
          </select>
          <button type="button" className="btn outline sm" onClick={() => void exportInterchange()}><Icon name="download" size="sm" />Export localized file…</button>
        </div>
      </div>
      <div className="grid2" style={{ alignItems: "start" }}>
        <div className="panel">
          <label className="field-l">Project name
            <input value={project.name} onChange={event => actions.renameProject(event.target.value)} />
          </label>
          <dl className="kv">
            <dt>Lines</dt><dd className="tabnum">{rows.length}</dd>
            <dt>Translated</dt><dd className="tabnum">{translated}</dd>
            <dt>Draft only</dt><dd className="tabnum">{drafts}</dd>
            <dt>Locked as final</dt><dd className="tabnum">{locked}</dd>
            <dt>Characters</dt><dd className="tabnum">{project.characters.length}</dd>
            <dt>Glossary terms</dt><dd className="tabnum">{project.glossary.length}</dd>
          </dl>
          <p className="muted" style={{ fontSize: 12 }}>
            {save.kind === "error"
              ? "Changes could not be saved. Export a .mori backup and check available disk space."
              : nativeMori() ? "Stored locally on this PC in Monku’s separate project library. Not synced to Google; export .mori backups too." : "Stored in this browser only. Nothing is synced to Google. Download a .mori copy for a backup."}
          </p>
        </div>
        <div className="panel">
          <h3>Source files</h3>
          {files.length ? files.map(file => {
            const lines = rows.filter(row => row.sourceFile === file);
            const done = lines.filter(row => statusOf(row) === "translated").length;
            return (
              <button key={file} type="button" className="list-item" onClick={() => { setView({ file }); go("matrix"); }}>
                <Icon name="file" size="sm" />
                <span className="opt-t"><span>{file}</span><span className="sub">{lines.length} lines</span></span>
                <span className="sub tabnum">{done} / {lines.length}</span>
              </button>
            );
          }) : <p className="muted" style={{ fontSize: 12.5 }}>No source files recorded.</p>}
        </div>
      </div>
      <GoogleSyncPanel />
      {nativeMori() && <div className="panel" style={{ marginTop: 18 }}> 
        <h3>Recovery snapshots</h3>
        <p className="muted" style={{ fontSize: 12 }}>Monku keeps previous versions of local project files. Export independent .mori backups too.</p>
        <button type="button" className="btn outline sm" onClick={() => void fetchRevisions()}>Show available snapshots</button>
        {revisions !== null && (revisions.length ? revisions.map(revision => (
          <div className="set-row" key={revision.id}>
            <span>{new Date(revision.at).toLocaleString()}</span><span className="grow" />
            <button type="button" className="btn sm outline" disabled={recovering || save.kind === "saving"} onClick={() => void (async () => {
              if (!window.confirm("Restore this snapshot? Save a .mori backup first. Current unsaved edits will be replaced.")) return;
              setRecovering(true);
              try {
                await restoreProjectRevision(project.id, revision.id);
                window.location.reload();
              } catch (cause) { toast(cause instanceof Error ? cause.message : "Restore failed."); setRecovering(false); }
            })()}>Restore</button>
          </div>
        )) : <p className="muted">No snapshots yet. Monku snapshots older project versions during saves.</p>)}
      </div>}
      <div className="panel" style={{ marginTop: 18, borderColor: "rgba(228,140,124,.3)" }}>
        <h3 style={{ color: "var(--berry)" }}>Danger zone</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="muted" style={{ fontSize: 12.5 }}>Deleting removes this project from the library. Desktop recovery snapshots may restore it.</span>
          <span className="grow" />
          <button type="button" className="btn outline sm danger" onClick={() => void remove()}>Delete project</button>
        </div>
      </div>
    </div>
  );
}

export function SettingsScreen() {
  const { prefs, setPrefs, setColumn, openModal } = useApp();
  return (
    <div className="screen">
      <ScreenHeader title="Settings" description="How the workspace looks. Translation data is never stored here." />
      <div className="panel" style={{ maxWidth: 720 }}>
        <div className="set-row">
          <div><b>Row density</b><span>Comfortable shows more room around each line; compact fits more lines on screen.</span></div>
          <div className="seg wide">
            {(["comfortable", "compact"] as const).map(density => (
              <button key={density} type="button" className={prefs.density === density ? "on" : ""} onClick={() => setPrefs({ density })}>
                {density === "comfortable" ? "Comfortable" : "Compact"}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div><b>Japanese text size</b><span>Scales translation text in the Matrix and the editor.</span></div>
          <div className="seg wide">
            {([["sm", "Small"], ["md", "Medium"], ["lg", "Large"]] as const).map(([size, label]) => (
              <button key={size} type="button" className={prefs.textSize === size ? "on" : ""} onClick={() => setPrefs({ textSize: size })}>{label}</button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div><b>Japanese font</b><span>Used for Japanese text. BIZ UDPGothic is the most legible on most systems.</span></div>
          <select className="sel" style={{ width: 260 }} value={prefs.jaFont} onChange={event => setPrefs({ jaFont: event.target.value })}>
            {JA_FONTS.map(font => <option key={font.value} value={font.value}>{font.label}</option>)}
          </select>
        </div>
        <div className="set-row">
          <div><b>Inspector</b><span>The panel on the right of the Matrix with checks, versions and voice notes.</span></div>
          <div className="seg wide">
            <button type="button" className={prefs.inspectorOpen ? "on" : ""} onClick={() => setPrefs({ inspectorOpen: true })}>Shown</button>
            <button type="button" className={!prefs.inspectorOpen ? "on" : ""} onClick={() => setPrefs({ inspectorOpen: false })}>Hidden</button>
          </div>
        </div>
        <div className="set-row">
          <div><b>Keyboard shortcuts</b><span>Change any shortcut. Press F1 at any time to open the list.</span></div>
          <button type="button" className="btn outline sm" onClick={() => openModal({ kind: "shortcuts" })}>Edit shortcuts</button>
        </div>
        <div className="set-row">
          <div><b>Columns</b><span>Put the Matrix columns back to their starting widths and visibility.</span></div>
          <button
            type="button"
            className="btn outline sm"
            onClick={() => (Object.keys(DEFAULT_COLUMN_PREFS) as (keyof typeof DEFAULT_COLUMN_PREFS)[]).forEach(key => setColumn(key, DEFAULT_COLUMN_PREFS[key]))}
          >
            Reset columns
          </button>
        </div>
        <GoogleConnect />
      </div>
    </div>
  );
}
