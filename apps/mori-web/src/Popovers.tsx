import { useRef, useState } from "react";
import { useApp } from "./app-context.ts";
import { Icon } from "./Icons.tsx";
import { Opt, PopLabel, PopSearch } from "./Overlays.tsx";
import { withSpeaker } from "./insights.ts";
import { readIndex, saveProject } from "./library.ts";
import { parseMoriProject, type MoriCharacter } from "./model.ts";
import { DEFAULT_COLUMN_PREFS, type ResizableColumn } from "./prefs.ts";
import { EXAMPLE_CHARACTERS, newTemplateId, readTemplates, useTemplates, writeTemplates, type CharacterTemplate } from "./templates.ts";
import { characterColor, cssVar } from "./theme.ts";

/** Body of whichever popover is open. Rendered inside PopoverFrame, reads live state from context. */
export function PopoverContent({ kind, rowId }: { kind: "speaker" | "speakerFilter" | "columns" | "projects" | "templates" | "integrations"; rowId?: string | undefined }) {
  switch (kind) {
    case "speaker": return rowId ? <SpeakerPopover rowId={rowId} /> : null;
    case "speakerFilter": return <SpeakerFilterPopover />;
    case "columns": return <ColumnsPopover />;
    case "projects": return <ProjectsPopover />;
    case "templates": return <TemplatesPopover />;
    case "integrations": return <IntegrationsPopover />;
  }
}

/** Shared by speaker choices: assign an existing character, or create one from a template. */
function useSpeakerChoices() {
  const { project, actions, activeRow, closePop, toast } = useApp();
  const templates = useTemplates();
  const savedCharacters = templates.filter((t): t is CharacterTemplate => t.kind === "character");

  const assign = (rowId: string, characterId: string | undefined) => {
    actions.updateRow(rowId, current => withSpeaker(current, characterId));
    closePop();
  };
  const createFrom = (rowId: string, fields: Partial<MoriCharacter>, label: string) => {
    const existing = project.characters.find(c => fields.name && c.name.toLowerCase() === fields.name.toLowerCase());
    const id = existing ? existing.id : actions.addCharacter(fields);
    actions.updateRow(rowId, current => withSpeaker(current, id));
    closePop();
    toast(existing ? `Assigned existing character “${existing.name}”.` : `Created “${label}”. Edit its voice in Characters.`);
  };
  return { project, savedCharacters, assign, createFrom };
}

function SpeakerPopover({ rowId }: { rowId: string }) {
  const { project, activeRow, openModal, closePop } = useApp();
  const { savedCharacters, assign, createFrom } = useSpeakerChoices();
  const [query, setQuery] = useState("");
  const row = project.rows.find(item => item.id === rowId) ?? activeRow;
  if (!row) return null;
  const needle = query.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const characters = project.characters.filter(c => matches(`${c.name} ${c.role}`));
  const examples = [...EXAMPLE_CHARACTERS, ...savedCharacters].filter(t => matches(`${t.name} ${t.tone}`));

  return (
    <>
      <PopSearch placeholder="Find or create a speaker…" value={query} onChange={setQuery} />
      {characters.length > 0 && <PopLabel>In this project</PopLabel>}
      {characters.map(c => (
        <Opt key={c.id} onPick={() => assign(row.id, c.id)}>
          <span className="avl" style={cssVar("--c", characterColor(c.id))}>{c.name.charAt(0)}</span>
          <span className="opt-t"><span>{c.name}</span><span className="sub">{c.role}</span></span>
          {row.characterId === c.id && <Icon name="check" size="sm" className="ok" />}
        </Opt>
      ))}
      {matches("unassigned") && (
        <Opt onPick={() => assign(row.id, undefined)}>
          <span className="avl empty" />
          <span className="opt-t"><span>Unassigned</span></span>
          {!row.characterId && <Icon name="check" size="sm" className="ok" />}
        </Opt>
      )}
      {(characters.length > 0 || matches("unassigned")) && <div className="pop-sep" />}
      <Opt onPick={() => {
        const name = query.trim() || "New character";
        createFrom(row.id, { name, role: "", tone: "", description: "" }, name);
      }}>
        <span className="avl" style={cssVar("--c", "#8ccfa7")}><Icon name="plus" size="xs" /></span>
        <span className="opt-t"><span>{needle ? `New character “${query.trim()}”` : "New character…"}</span></span>
      </Opt>
      {examples.length > 0 && <PopLabel>From templates</PopLabel>}
      {examples.map(template => (
        <Opt
          key={template.id}
          onPick={() => createFrom(row.id, { name: template.name, role: template.role, tone: template.tone, description: template.description }, template.name)}
        >
          <span className="avl" style={cssVar("--c", characterColor(template.id))}><Icon name="layers" size="xs" /></span>
          <span className="opt-t"><span>{template.name}</span><span className="sub">{template.tone}</span></span>
        </Opt>
      ))}
      <div className="pop-sep" />
      <Opt onPick={() => { closePop(); openModal({ kind: "templates" }); }}>
        <Icon name="layers" size="sm" />
        <span className="opt-t"><span>Manage templates…</span></span>
      </Opt>
    </>
  );
}

function SpeakerFilterPopover() {
  const { project, view, setView, closePop } = useApp();
  const pick = (speaker: string) => {
    setView({ speaker });
    closePop();
  };
  const countOf = (characterId: string | undefined) => project.rows.filter(row => characterId ? row.characterId === characterId : !row.characterId).length;
  return (
    <>
      <PopLabel>Show lines spoken by</PopLabel>
      <Opt onPick={() => pick("any")}>
        <span className="opt-t"><span>Any speaker</span></span>
        {view.speaker === "any" && <Icon name="check" size="sm" className="ok" />}
      </Opt>
      {project.characters.map(c => (
        <Opt key={c.id} onPick={() => pick(c.id)}>
          <span className="avl" style={cssVar("--c", characterColor(c.id))}>{c.name.charAt(0)}</span>
          <span className="opt-t"><span>{c.name}</span></span>
          <span className="sub tabnum">{countOf(c.id)}</span>
          {view.speaker === c.id && <Icon name="check" size="sm" className="ok" />}
        </Opt>
      ))}
      <Opt onPick={() => pick("none")}>
        <span className="avl empty" />
        <span className="opt-t"><span>Unassigned</span></span>
        <span className="sub tabnum">{countOf(undefined)}</span>
        {view.speaker === "none" && <Icon name="check" size="sm" className="ok" />}
      </Opt>
    </>
  );
}

const COLLAPSIBLE: { key: ResizableColumn; label: string; color: string }[] = [
  { key: "speaker", label: "Speaker", color: "var(--text-3)" },
  { key: "src", label: "Source · EN", color: "#a6b6ac" },
  { key: "dev", label: "Dev draft", color: "#c2b18e" },
  { key: "ai", label: "AI draft", color: "#9cbbe0" },
];

function ColumnsPopover() {
  const { prefs, setPrefs, setColumn } = useApp();
  return (
    <>
      <PopLabel>Columns</PopLabel>
      {COLLAPSIBLE.map(column => {
        const shown = !prefs.columns[column.key].collapsed;
        return (
          <Opt key={column.key} onPick={() => setColumn(column.key, { collapsed: shown })}>
            <span className={`cb${shown ? " on" : ""}`}>{shown && <Icon name="check" />}</span>
            <span className="sw" style={cssVar("--c", column.color)} />
            <span className="opt-t"><span>{column.label}</span></span>
          </Opt>
        );
      })}
      <p className="pop-note">Collapsed columns stay as a thin strip. A dot shows when a line has content there.</p>
      <div className="pop-sep" />
      <PopLabel>Row density</PopLabel>
      {(["comfortable", "compact"] as const).map(density => (
        <Opt key={density} onPick={() => setPrefs({ density })}>
          <span className="opt-t"><span>{density === "comfortable" ? "Comfortable" : "Compact"}</span></span>
          {prefs.density === density && <Icon name="check" size="sm" className="ok" />}
        </Opt>
      ))}
      <div className="pop-sep" />
      <Opt onPick={() => COLLAPSIBLE.forEach(column => setColumn(column.key, DEFAULT_COLUMN_PREFS[column.key]))}>
        <Icon name="reset" size="sm" />
        <span className="opt-t"><span>Reset columns</span></span>
      </Opt>
    </>
  );
}

function ProjectsPopover() {
  const { project, library, openProject, openModal, closePop, toast } = useApp();
  const fileInput = useRef<HTMLInputElement>(null);
  const openFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const opened = parseMoriProject(JSON.parse(await file.text()) as unknown);
      // A file whose ID is already in this browser is opened as a copy, so the stored project is never overwritten.
      const copy = readIndex().some(entry => entry.id === opened.id);
      const parsed = copy ? { ...opened, id: crypto.randomUUID(), name: `${opened.name} (copy)` } : opened;
      await saveProject(parsed);
      closePop();
      await openProject(parsed.id);
      toast(copy ? `“${opened.name}” is already here, so this file opened as a copy.` : `Opened “${parsed.name}”. The original file was not changed.`);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "That file couldn’t be opened.");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  return (
    <>
      <PopLabel>Projects</PopLabel>
      {library.map(entry => (
        <Opt key={entry.id} onPick={() => { if (entry.id !== project.id) void openProject(entry.id); else closePop(); }}>
          <span className="pmark" style={{ width: 26, height: 26, fontSize: 10.5 }}>{entry.name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? "").join("")}</span>
          <span className="opt-t">
            <span>{entry.name}</span>
            <span className="sub">EN → JA · {entry.lines} lines · {entry.translated} translated</span>
          </span>
          {entry.id === project.id && <Icon name="check" size="sm" className="ok" />}
        </Opt>
      ))}
      <div className="pop-sep" />
      <Opt onPick={() => { closePop(); openModal({ kind: "import", step: 1 }); }}>
        <Icon name="plus" size="sm" />
        <span className="opt-t"><span>New project…</span></span>
      </Opt>
      <Opt onPick={() => fileInput.current?.click()}>
        <Icon name="open" size="sm" />
        <span className="opt-t"><span>Open a .mori file…</span></span>
      </Opt>
      <input
        ref={fileInput}
        type="file"
        accept=".mori,application/json"
        hidden
        onChange={event => void openFile(event.target.files?.[0])}
      />
      {library.length === 0 && <p className="pop-note">No projects in this browser yet.</p>}
    </>
  );
}

function TemplatesPopover() {
  const { project, actions, openModal, closePop, toast } = useApp();
  const templates = useTemplates();
  const contexts = templates.filter(t => t.kind === "context");
  const characters = templates.filter(t => t.kind === "character");
  const glossaries = templates.filter(t => t.kind === "glossary");

  const applyContext = (template: { global: string; project: string; name: string }) => {
    const replacing = project.context.global.trim() || project.context.project.trim();
    if (replacing && !window.confirm(`Replace this project’s context with “${template.name}”?`)) return;
    actions.setContext("global", template.global);
    actions.setContext("project", template.project);
    closePop();
    toast(`Applied “${template.name}” to context.`);
  };
  const applyGlossary = (template: { name: string; terms: { en: string; jp: string; explanation: string }[] }) => {
    const known = new Set(project.glossary.map(term => term.en.trim().toLowerCase()));
    const added = template.terms.filter(term => term.en.trim() && !known.has(term.en.trim().toLowerCase()));
    added.forEach(term => actions.addGlossary({ en: term.en, jp: term.jp, explanation: term.explanation }));
    closePop();
    toast(added.length ? `Added ${added.length} term${added.length === 1 ? "" : "s"} from “${template.name}”.` : `Every term in “${template.name}” is already in the glossary.`);
  };
  const saveContext = () => {
    const name = window.prompt("Name this context template", "Project context");
    if (!name?.trim()) return;
    writeTemplates([...readTemplates(), {
      kind: "context", id: newTemplateId(), name: name.trim(),
      global: project.context.global, project: project.context.project,
    }]);
    closePop();
    toast(`Saved “${name.trim()}” as a template.`);
  };

  return (
    <>
      <PopLabel>Context</PopLabel>
      {contexts.map(t => t.kind === "context" && (
        <Opt key={t.id} onPick={() => applyContext(t)}>
          <Icon name="scroll" size="sm" />
          <span className="opt-t"><span>{t.name}</span><span className="sub">{t.global || t.project || "Empty"}</span></span>
        </Opt>
      ))}
      {contexts.length === 0 && <p className="pop-note">No saved context templates yet.</p>}
      <PopLabel>Characters</PopLabel>
      {[...EXAMPLE_CHARACTERS, ...characters.filter((t): t is CharacterTemplate => t.kind === "character")].map(t => (
        <Opt key={t.id} onPick={() => {
          const existing = project.characters.find(c => c.name.toLowerCase() === t.name.toLowerCase());
          if (!existing) actions.addCharacter({ name: t.name, role: t.role, tone: t.tone, description: t.description });
          closePop();
          toast(existing ? `“${t.name}” is already a character in this project.` : `Added “${t.name}” to characters.`);
        }}>
          <span className="avl" style={cssVar("--c", characterColor(t.id))}>{t.name.charAt(0)}</span>
          <span className="opt-t"><span>{t.name}</span><span className="sub">{t.tone}</span></span>
        </Opt>
      ))}
      <PopLabel>Glossaries</PopLabel>
      {glossaries.map(t => t.kind === "glossary" && (
        <Opt key={t.id} onPick={() => applyGlossary(t)}>
          <Icon name="book" size="sm" />
          <span className="opt-t"><span>{t.name}</span><span className="sub">{t.terms.length} terms</span></span>
        </Opt>
      ))}
      {glossaries.length === 0 && <p className="pop-note">Save a glossary from the Glossary screen.</p>}
      <div className="pop-sep" />
      <Opt onPick={saveContext}>
        <Icon name="plus" size="sm" />
        <span className="opt-t"><span>Save this project’s context as template</span></span>
      </Opt>
      <Opt onPick={() => { closePop(); openModal({ kind: "templates" }); }}>
        <Icon name="layers" size="sm" />
        <span className="opt-t"><span>Manage templates…</span></span>
      </Opt>
    </>
  );
}

function IntegrationsPopover() {
  return (
    <>
      <PopLabel>Google Workspace</PopLabel>
      <div className="opt" style={{ cursor: "default" }}>
        <span className="opt-t">
          <span>Google Workspace account</span>
          <span className="sub">Connect or sign out from Settings. Use New project → Sources to browse private Drive Docs and Sheets, create protected copies, and import them.</span>
        </span>
      </div>
      <div className="pop-sep" />
      <p className="pop-note">Public links import read-only. Signed-in imports make new copies, with optional manual Japanese-only sync to those copies from Project &amp; files.</p>
    </>
  );
}
