import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "./app-context.ts";
import { reloadUiTranslations, tr, useUiLanguage } from "./ui-localization.ts";
import { Icon } from "./Icons.tsx";
import { checkRow, statusOf, termImpact } from "./insights.ts";
import { JA_FONTS, DEFAULT_COLUMN_PREFS, DRAFT_AHEAD_OPTIONS } from "./prefs.ts";
import { newTemplateId, readTemplates, writeTemplates } from "./templates.ts";
import { characterColor, cssVar } from "./theme.ts";
import type { MoriProject } from "./model.ts";
import { nativeMori } from "./backend.ts";
import { listProjectRevisions, restoreProjectRevision } from "./library.ts";
import { GoogleSyncPanel } from "./GoogleSyncPanel.tsx";
import { GoogleConnect } from "./GoogleConnect.tsx";
import { browserDownload, buildInterchangeExport, chooseText, type ExportFormat, type TranslationMode } from "./exporters.ts";
import { readExportPreferences, writeExportPreferences } from "./export-preferences.ts";
import { buildOriginalExport, canExportOriginals, downloadOriginalExport, originalExportData } from "./roundtrip.ts";

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
  const { project, actions, toast, openModal } = useApp();
  // Japanese each term had when the translator started editing it, so a change can be carried into her lines.
  const [startJp, setStartJp] = useState<Record<string, string>>({});
  const addTerm = () => openModal({ kind: "term" });
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
      <ScreenHeader title="Glossary" description="Terms that must stay consistent. Lines that use a term are underlined in the Matrix and checked. Tip: select a word in the Matrix to add it.">
        <button type="button" className="btn outline sm" onClick={saveTemplate}><Icon name="layers" size="sm" />Save as template</button>
        <button type="button" className="btn outline sm" onClick={addTerm}><Icon name="plus" size="sm" />Add term</button>
      </ScreenHeader>
      <table className="gl-table">
        <thead>
          <tr><th style={{ width: "24%" }}>English</th><th style={{ width: "24%" }}>Japanese</th><th>Note</th><th style={{ width: 150 }}>Lines</th><th style={{ width: 40 }} /></tr>
        </thead>
        <tbody>
          {project.glossary.map(term => {
            const previous = startJp[term.id] ?? "";
            const impact = termImpact(project.rows, term, previous);
            return (
              <tr key={term.id}>
                <td><input value={term.en} aria-label="English term" onChange={event => actions.updateGlossary(term.id, { en: event.target.value })} /></td>
                <td>
                  <input
                    className="ja"
                    lang="ja"
                    value={term.jp}
                    aria-label="Japanese term"
                    onChange={event => {
                      setStartJp(current => term.id in current ? current : { ...current, [term.id]: term.jp.trim() });
                      actions.updateGlossary(term.id, { jp: event.target.value });
                    }}
                  />
                </td>
                <td><input value={term.explanation} aria-label="Note" onChange={event => actions.updateGlossary(term.id, { explanation: event.target.value })} /></td>
                <td className="gl-use">
                  {impact.replaceable.length > 0 && term.jp.trim() ? (
                    <button type="button" className="btn xs primary" title={`Replace ${previous} with ${term.jp.trim()} in your translations`}
                      onClick={() => openModal({ kind: "term", termId: term.id, previousJp: previous })}>
                      Update {impact.replaceable.length} line{impact.replaceable.length === 1 ? "" : "s"}
                    </button>
                  ) : (
                    <button type="button" className="gl-lines" title="See how this term is used" onClick={() => openModal({ kind: "term", termId: term.id })}>
                      <span className="tabnum">{impact.lines.length}</span>
                      {impact.mismatched.length > 0 && <span className="warn tabnum">· {impact.mismatched.length} differ</span>}
                    </button>
                  )}
                </td>
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
  const { project, actions, deleteProject, toast, save, setView, go, select } = useApp();
  const rows = project.rows;
  const translated = rows.filter(row => statusOf(row) === "translated").length;
  const drafts = rows.filter(row => statusOf(row) === "draft").length;
  const locked = rows.filter(row => row.isLocked).length;
  const files = [...new Set([...project.sourceFiles ?? [], ...rows.map(row => row.sourceFile ?? "")])].filter(Boolean);
  const [revisions, setRevisions] = useState<{ id: string; at: number }[] | null>(null);
  useEffect(() => {
    if (!nativeMori()) return;
    void listProjectRevisions(project.id).then(setRevisions).catch(() => {});
  }, [project.id]);
  const [recovering, setRecovering] = useState(false);
  const [exportSettings, setExportSettings] = useState(() => readExportPreferences(project.id));
  const exportFormat = exportSettings.format;
  const exportMode = exportSettings.mode;
  const [pendingExport, setPendingExport] = useState<{ kind: "table" | "original"; quick: boolean } | null>(null);
  const [exporting, setExporting] = useState(false);
  const updateExport = (patch: Partial<typeof exportSettings>) => {
    setExportSettings(current => ({ ...current, ...patch }));
    writeExportPreferences(project.id, patch);
  };
  const missingCount = project.rows.filter(row => !chooseText(row, exportMode).trim()).length;
  const qualityIssues = project.rows.flatMap(row =>
    checkRow({ ...row, final: chooseText(row, exportMode) }, project.glossary).map(warning => ({
      id: row.id, message: warning.message,
      critical: warning.kind === "missing-token" || warning.kind === "extra-token" || warning.kind === "locked-empty",
    })));
  const criticalCount = qualityIssues.filter(issue => issue.critical).length;
  const requestExport = (kind: "table" | "original", quick = false) => {
    if (exporting) return;
    if (missingCount || qualityIssues.length) {
      setPendingExport({ kind, quick });
    } else {
      void performExport(kind, quick);
    }
  };
  const performExport = async (kind: "table" | "original", quick: boolean) => {
    setPendingExport(null);
    setExporting(true);
    try {
      const native = nativeMori();
      if (kind === "table") {
        const report = buildInterchangeExport(project, exportFormat, exportMode);
        if (native) {
          const saved = await native.exportInterchange({ ...report, projectId: project.id, quick });
          if (saved) {
            updateExport({ lastTable: { ...exportSettings.lastTable, [exportFormat]: saved.filename } });
            toast(`Exported ${saved.filename}.`);
          }
        } else {
          browserDownload(report);
          toast(`Exported ${report.filename}.`);
        }
      } else {
        const result = await buildOriginalExport(project, exportMode);
        if (!result.files.length) throw Error("No original files are available to export.");
        if (native) {
          const output = originalExportData(project, result);
          const saved = await native.exportOriginals({ projectId: project.id, format: "original", ...output, quick });
          if (saved) {
            updateExport({ lastOriginal: saved.filename });
            toast(`Exported ${saved.filename}.`);
          }
        } else {
          toast(`Exported ${downloadOriginalExport(project, result)}.`);
        }
      }
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Export failed.");
    } finally {
      setExporting(false);
    }
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
      <div className="panel export-panel" style={{ marginBottom: 18 }}>
        <h3>Export translations</h3>
        <div className="export-row">
          <div>
            <b>Back into the original files</b>
            <p className="muted">
              {canExportOriginals(project)
                ? "Copies of the imported files in their own format, with your Japanese written in. A spreadsheet gets it in its translation column (or a new “Japanese” column); JSON, PO, scripts, text and Word files get it in place of the English. Several files export as one zip."
                : "This project was imported before Monku kept the original files. Add the files again from the Files list (+) to enable this; your translations stay."}
            </p>
          </div>
          <button type="button" className="btn primary sm" disabled={!canExportOriginals(project) || exporting} onClick={() => requestExport("original")}>
            <Icon name="download" size="sm" />{exporting ? "Exporting…" : "Export files…"}
          </button>
          {nativeMori() && exportSettings.lastOriginal && (
            <button type="button" className="btn outline sm" disabled={exporting} title={`Export again to ${exportSettings.lastOriginal}`}
              onClick={() => requestExport("original", true)}>Quick export</button>
          )}
        </div>
        <div className="export-row">
          <div>
            <b>One table of every line</b>
            <p className="muted">A normalized translation list, for handing over or reviewing elsewhere.</p>
          </div>
          <select className="sel" aria-label="Export format" value={exportFormat} onChange={event => updateExport({ format: event.target.value as ExportFormat })}>
            <option value="csv">CSV (Excel-friendly)</option><option value="json">JSON interchange</option><option value="po">Gettext PO</option>
          </select>
          <button type="button" className="btn outline sm" disabled={exporting} onClick={() => requestExport("table")}><Icon name="download" size="sm" />Export table…</button>
          {nativeMori() && exportSettings.lastTable?.[exportFormat] && (
            <button type="button" className="btn outline sm" disabled={exporting} title={`Export again to ${exportSettings.lastTable[exportFormat]}`}
              onClick={() => requestExport("table", true)}>Quick export</button>
          )}
        </div>
        <label className="export-mode">
          Text to use
          <select className="sel" aria-label="Translation source" value={exportMode} onChange={event => updateExport({ mode: event.target.value as TranslationMode })}>
            <option value="curated">Curated text only</option><option value="curated-or-draft">Use AI/dev draft when not curated (review carefully)</option>
          </select>
        </label>
        {pendingExport && (
          <div className="mori-export-check" role="region" aria-label="Review export quality">
            <b>Before exporting: {missingCount} without output text, {criticalCount} critical issue{criticalCount === 1 ? "" : "s"}, {qualityIssues.length - criticalCount} other warning{qualityIssues.length - criticalCount === 1 ? "" : "s"}.</b>
            <p className="muted">{pendingExport.kind === "original"
              ? "Untranslated entries keep their original file text."
              : "Untranslated entries are left blank in the exported table."} You can fix these now or export anyway.</p>
            {qualityIssues.length > 0 && <p className="muted">{qualityIssues.slice(0, 3).map(issue => `${issue.id}: ${issue.message}`).join(" · ")}</p>}
            <div className="mori-export-check-actions">
              {missingCount > 0 && <button type="button" className="btn outline sm" onClick={() => { setPendingExport(null); setView({ filter: "todo", file: null, term: null, query: "" }); go("matrix"); }}>Review untranslated</button>}
              {qualityIssues.length > 0 && <button type="button" className="btn outline sm" onClick={() => {
                setPendingExport(null);
                setView({ filter: exportMode === "curated" ? "warnings" : "all", file: null, term: null, query: "" });
                if (exportMode !== "curated" && qualityIssues[0]) select(qualityIssues[0].id);
                go("matrix");
              }}>Review warnings</button>}
              <button type="button" className="btn sm" onClick={() => setPendingExport(null)}>Cancel</button>
              <button type="button" className="btn primary sm" onClick={() => void performExport(pendingExport.kind, pendingExport.quick)}>Export anyway</button>
            </div>
          </div>
        )}
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
        <p className="muted" style={{ fontSize: 12 }}>
          {revisions?.length ? `Latest recovery snapshot: ${new Date(revisions[0]!.at).toLocaleString()}` : "No previous recovery snapshot yet."}
          {save.kind === "saved" ? ` · Current edits saved at ${new Date(save.at).toLocaleTimeString()}` : save.kind === "saving" ? " · Saving current edits…" : save.kind === "error" ? ` · Save failed: ${save.message}` : ""}
        </p>
        <button type="button" className="btn outline sm" onClick={() => void fetchRevisions()}>Refresh snapshots</button>
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
  const { prefs, setPrefs, setColumn, openModal, toast } = useApp();
  const { language, setLanguage, translated } = useUiLanguage();
  const [reloadingUi, setReloadingUi] = useState(false);
  const reloadTranslations = async () => {
    if (reloadingUi) return;
    setReloadingUi(true);
    try {
      const count = await reloadUiTranslations();
      toast(`Reloaded ${count} Japanese interface translations.`);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not reload interface translations.");
    } finally {
      setReloadingUi(false);
    }
  };
  return (
    <div className="screen">
      <ScreenHeader title={tr("Settings")} description={tr("How the workspace looks. Translation data is never stored here.")} />
      <div className="panel" style={{ maxWidth: 720 }}>
        <div className="set-row">
          <div><b>{tr("Language")}</b><span>Choose the application interface language. Japanese uses translations from the “Monku no Mori · Interface” project ({translated} available); untranslated labels remain English.</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <div className="seg wide" role="group" aria-label="Interface language">
              <button type="button" className={language === "en" ? "on" : ""} onClick={() => setLanguage("en")}>English</button>
              <button type="button" className={language === "ja" ? "on" : ""} onClick={() => setLanguage("ja")}>日本語</button>
            </div>
            <button type="button" className="btn outline sm" aria-label="Reload interface translations"
              title="Re-read curated Japanese translations from the Monku no Mori interface project"
              disabled={reloadingUi} onClick={() => { void reloadTranslations(); }}>
              <Icon name="reset" size="sm" />{reloadingUi ? "Reloading…" : "Reload"}
            </button>
          </div>
        </div>
        <div className="set-row">
          <div><b>{tr("Row density")}</b><span>Comfortable shows more room around each line; compact fits more lines on screen.</span></div>
          <div className="seg wide">
            {(["comfortable", "compact"] as const).map(density => (
              <button key={density} type="button" className={prefs.density === density ? "on" : ""} onClick={() => setPrefs({ density })}>
                {tr(density === "comfortable" ? "Comfortable" : "Compact")}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div><b>{tr("Japanese text size")}</b><span>{tr("Scales translation text in the Matrix and the editor.")}</span></div>
          <div className="seg wide">
            {([["sm", "Small"], ["md", "Medium"], ["lg", "Large"]] as const).map(([size, label]) => (
              <button key={size} type="button" className={prefs.textSize === size ? "on" : ""} onClick={() => setPrefs({ textSize: size })}>{label}</button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div><b>{tr("Japanese font")}</b><span>{tr("Used for Japanese text. BIZ UDPGothic is the most legible on most systems.")}</span></div>
          <select className="sel" style={{ width: 260 }} value={prefs.jaFont} onChange={event => setPrefs({ jaFont: event.target.value })}>
            {JA_FONTS.map(font => <option key={font.value} value={font.value}>{font.label}</option>)}
          </select>
        </div>
        <div className="set-row">
          <div><b>{tr("Japanese field click")}</b><span>When you click a translation in the Matrix to start editing, choose where the cursor goes.</span></div>
          <div className="seg wide" role="group" aria-label="Japanese field click behavior">
            {([["position", "Where clicked"], ["end", "At end"], ["selectAll", "Select all"]] as const).map(([mode, label]) => (
              <button key={mode} type="button" className={prefs.japaneseClickMode === mode ? "on" : ""} onClick={() => setPrefs({ japaneseClickMode: mode })}>{label}</button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div><b>{tr("Characters")}</b><span>Hide character tools, speaker controls and voice context in translation requests. Existing characters are preserved.</span></div>
          <div className="seg wide" role="group" aria-label="Enable characters">
            <button type="button" className={prefs.charactersEnabled ? "on" : ""} onClick={() => setPrefs({ charactersEnabled: true })}>On</button>
            <button type="button" className={!prefs.charactersEnabled ? "on" : ""} onClick={() => setPrefs({ charactersEnabled: false })}>Off</button>
          </div>
        </div>
        <div className="set-row">
          <div><b>{tr("Glossary")}</b><span>Hide terminology tools and stop using glossary terms for translation suggestions, highlights or warnings. Saved terms are preserved.</span></div>
          <div className="seg wide" role="group" aria-label="Enable glossary">
            <button type="button" className={prefs.glossaryEnabled ? "on" : ""} onClick={() => setPrefs({ glossaryEnabled: true })}>On</button>
            <button type="button" className={!prefs.glossaryEnabled ? "on" : ""} onClick={() => setPrefs({ glossaryEnabled: false })}>Off</button>
          </div>
        </div>
        <div className="set-row">
          <div><b>AI drafts ahead</b><span>Desktop app. Mori keeps AI drafts ready for this many lines after the one you are on, using Codex Luna 6 (low). Drafts never replace your text, and a draft that misses a glossary term is redone.</span></div>
          <div className="seg wide" role="group" aria-label="AI drafts ahead">
            {DRAFT_AHEAD_OPTIONS.map(count => (
              <button key={count} type="button" className={prefs.draftAhead === count ? "on" : ""} onClick={() => setPrefs({ draftAhead: count })}>{count || "Off"}</button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div><b>Inspector</b><span>The panel on the right of the Matrix with checks, versions and voice notes.</span></div>
          <div className="seg wide">
            <button type="button" className={prefs.inspectorOpen ? "on" : ""} onClick={() => setPrefs({ inspectorOpen: true })}>Shown</button>
            <button type="button" className={!prefs.inspectorOpen ? "on" : ""} onClick={() => setPrefs({ inspectorOpen: false })}>Hidden</button>
          </div>
        </div>
        <div className="set-row">
          <div><b>{tr("Keyboard shortcuts")}</b><span>Change any shortcut. Press F1 at any time to open the list.</span></div>
          <button type="button" className="btn outline sm" onClick={() => openModal({ kind: "shortcuts" })}>{tr("Edit shortcuts")}</button>
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
        <div id="mori-google-workspace">
          <GoogleConnect showImportDestinations onImport={(tables, destination) => openModal({ kind: "import", step: 2, add: destination !== "new", tables })} />
        </div>
      </div>
    </div>
  );
}
