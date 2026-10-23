import { useEffect, useRef, useState } from "react";
import { useApp } from "./app-context.ts";
import { Icon } from "./Icons.tsx";
import { KeyCaps } from "./Overlays.tsx";
import { ACTIONS, assignBinding, clearBinding, defaultBindings, keyLabel, keyString, type ActionDef, type ActionGroup, type ActionId } from "./shortcuts.ts";
import { useTemplates, writeTemplates, readTemplates, type MoriTemplate } from "./templates.ts";
import type { MoriRow } from "./model.ts";

interface CaptureNote {
  id: ActionId;
  message: string;
}

/** Click a shortcut, press the new keys. A key already in use is swapped with the other action. */
export function ShortcutsModal() {
  const { bindings, setBindings, capturingRef } = useApp();
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  const [note, setNote] = useState<CaptureNote | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!capturing) return;
    capturingRef.current = true;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        setBindings(clearBinding(bindings, capturing));
        setNote(null);
        setCapturing(null);
        return;
      }
      const binding = keyString(event);
      if (!binding) return;
      const previous = bindings[capturing];
      const result = assignBinding(bindings, capturing, binding);
      if (result.error) {
        setNote({ id: capturing, message: result.error });
        return;
      }
      setBindings(result.bindings);
      const swapped = result.swappedWith;
      setNote(swapped
        ? { id: capturing, message: `${keyLabel(binding)} was used by “${swapped.label}”. Swapped: that one is now ${previous ? keyLabel(previous) : "unset"}.` }
        : null);
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      capturingRef.current = false;
    };
  }, [capturing, bindings, setBindings, capturingRef]);

  const filtered = (action: ActionDef) => !query.trim() || action.label.toLowerCase().includes(query.trim().toLowerCase());
  const column = (groups: ActionGroup[]) => groups.map(group => (
    <div key={group} className="sk-g">
      <h4>{group}</h4>
      {ACTIONS.filter(action => action.group === group && filtered(action)).map(action => (
        <div key={action.id}>
          <div className="sk">
            <span>{action.label}</span>
            {bindings[action.id] !== action.def && (
              <>
                <span className="changed" title={`Changed from ${keyLabel(action.def)}`} />
                <button
                  type="button"
                  className="ib"
                  title={`Reset to ${keyLabel(action.def)}`}
                  aria-label={`Reset ${action.label}`}
                  onClick={() => { setBindings({ ...bindings, [action.id]: action.def }); setNote(null); }}
                >
                  <Icon name="reset" size="xs" />
                </button>
              </>
            )}
            <button
              type="button"
              className={`sk-key${capturing === action.id ? " capture" : ""}`}
              title="Click, then press the new keys"
              onClick={() => { setNote(null); setCapturing(capturing === action.id ? null : action.id); }}
            >
              {capturing === action.id ? "Press keys… (Esc cancels, ⌫ clears)" : <KeyCaps binding={bindings[action.id]} />}
            </button>
          </div>
          {note?.id === action.id && <div className="sk-note">{note.message}</div>}
        </div>
      ))}
    </div>
  ));

  return (
    <>
      <div className="m-head">
        <Icon name="keyboard" />
        <h2>Keyboard shortcuts</h2>
        <span className="grow" />
        <label className="field sm" style={{ width: 220 }}>
          <Icon name="search" size="sm" />
          <input placeholder="Find a shortcut" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        <CloseButton />
      </div>
      <div className="m-body">
        <div className="sk-cols">
          <div>{column(["Moving around", "Window"])}</div>
          <div>{column(["Translating"])}</div>
        </div>
      </div>
      <div className="m-foot">
        <span className="muted" style={{ fontSize: 12 }}>Click a shortcut and press new keys. Shortcuts pause while the Japanese IME is composing.</span>
        <span className="grow" />
        <button type="button" className="btn outline sm" onClick={() => { setBindings(defaultBindings()); setNote(null); }}>
          <Icon name="reset" size="sm" />Reset all
        </button>
        <CloseButton label="Done" primary />
      </div>
    </>
  );
}

function CloseButton({ label, primary }: { label?: string; primary?: boolean }) {
  const { closeModal } = useApp();
  if (label) return <button type="button" className={`btn sm${primary ? " primary" : ""}`} onClick={closeModal}>{label}</button>;
  return <button type="button" className="ib" aria-label="Close" onClick={closeModal}><Icon name="x" size="sm" /></button>;
}

type PaletteItem = { title: string; detail: string; keys?: string; run: () => void };

/** Ctrl+K: actions, characters and lines in one list. Arrows move, Enter opens. */
export function PaletteModal() {
  const { project, bindings, closeModal, runAction, setView, select, go } = useApp();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items: PaletteItem[] = [
    ...ACTIONS.map(action => ({
      title: action.label,
      detail: "Action",
      keys: bindings[action.id],
      run: () => runAction(action.id as ActionId),
    })),
    ...project.characters.map(character => ({
      title: character.name,
      detail: `Character · ${character.role || "no role yet"}`,
      run: () => { setView({ speaker: character.id, filter: "all", file: null }); go("matrix"); },
    })),
    ...project.rows.map((row: MoriRow) => ({
      title: row.source.replace(/\n/g, " "),
      detail: row.id,
      run: () => { setView({ query: "", filter: "all", speaker: "any", file: null }); go("matrix"); select(row.id, true); },
    })),
  ];
  const needle = query.trim().toLowerCase();
  const results = items.filter(item => !needle || `${item.title} ${item.detail}`.toLowerCase().includes(needle)).slice(0, 40);
  const current = Math.min(highlight, Math.max(0, results.length - 1));

  useEffect(() => { inputRef.current?.focus(); }, []);

  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    closeModal();
    item.run();
  };

  return (
    <>
      <div className="pop-search">
        <Icon name="search" />
        <input
          ref={inputRef}
          placeholder="Search lines, characters, actions…"
          aria-label="Search lines, characters, actions"
          value={query}
          onChange={event => { setQuery(event.target.value); setHighlight(0); }}
          onKeyDown={event => {
            if (event.key === "ArrowDown") { event.preventDefault(); setHighlight(Math.min(current + 1, results.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight(Math.max(current - 1, 0)); }
            else if (event.key === "Enter") { event.preventDefault(); pick(results[current]); }
          }}
        />
      </div>
      <div className="pal-list">
        {results.map((item, index) => (
          <button
            key={`${item.detail}-${index}`}
            type="button"
            className={`opt${index === current ? " hi" : ""}`}
            onMouseEnter={() => setHighlight(index)}
            onClick={() => pick(item)}
          >
            <span className="opt-t"><span>{item.title}</span><span className="sub">{item.detail}</span></span>
            {item.keys && <KeyCaps binding={item.keys} />}
          </button>
        ))}
        {!results.length && <p className="pop-note">Nothing found.</p>}
      </div>
    </>
  );
}

const TEMPLATE_KIND_LABEL: Record<MoriTemplate["kind"], string> = { character: "Character", context: "Context", glossary: "Glossary" };

/** Saved templates. Built-in examples are not listed here because they can't be edited or deleted. */
export function TemplatesModal() {
  const { closeModal, toast } = useApp();
  const templates = useTemplates();
  const remove = (id: string) => {
    writeTemplates(readTemplates().filter(template => template.id !== id));
    toast("Template deleted. Projects that already used it keep their copy.");
  };
  return (
    <>
      <div className="m-head">
        <Icon name="layers" />
        <h2>Templates</h2>
        <span className="grow" />
        <button type="button" className="ib" aria-label="Close" onClick={closeModal}><Icon name="x" size="sm" /></button>
      </div>
      <div className="m-body">
        {templates.length === 0 && (
          <p className="muted" style={{ fontSize: 12.5 }}>
            Nothing saved yet. Save a character from its speaker card, a glossary from the Glossary screen, or a context from the Templates menu.
          </p>
        )}
        {templates.map(template => (
          <div key={template.id} className="tpl-row">
            <span className="tag">{TEMPLATE_KIND_LABEL[template.kind]}</span>
            <div className="opt-t">
              <span>{template.name}</span>
              <span className="sub">{describe(template)}</span>
            </div>
            <button type="button" className="btn xs outline danger" onClick={() => remove(template.id)}>Delete</button>
          </div>
        ))}
      </div>
      <div className="m-foot">
        <span className="grow" />
        <button type="button" className="btn primary sm" onClick={closeModal}>Done</button>
      </div>
    </>
  );
}

function describe(template: MoriTemplate): string {
  if (template.kind === "character") return template.tone || template.role || "Character";
  if (template.kind === "context") return template.global || template.project || "Empty context";
  return `${template.terms.length} term${template.terms.length === 1 ? "" : "s"}`;
}
