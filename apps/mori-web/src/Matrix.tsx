import { useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useApp } from "./app-context.ts";
import { Icon } from "./Icons.tsx";
import { KeyCaps } from "./Overlays.tsx";
import { Marked } from "./Marked.tsx";
import { checkRow, matchesFilter, statusOf, type RowFilter } from "./insights.ts";
import { editFinalText, type MoriRow } from "./model.ts";
import type { MoriPrefs, ResizableColumn } from "./prefs.ts";
import { keyLabel } from "./shortcuts.ts";
import { characterColor, cssVar } from "./theme.ts";

type ColumnKey = "id" | "speaker" | "src" | "dev" | "ai" | "tr" | "st";

interface ColumnDef {
  key: ColumnKey;
  label: string;
  color?: string;
  /** Fixed width in px, or a flexible track: `fr` with a `min` floor. */
  fixed?: number;
  fr?: number;
  min?: number;
  collapsible?: boolean;
  resizable?: boolean;
}

const COLUMN_DEFS: ColumnDef[] = [
  { key: "id", label: "Line", fixed: 96 },
  { key: "speaker", label: "Speaker", fixed: 136, min: 96, collapsible: true, resizable: true },
  { key: "src", label: "Source · EN", fr: 1.1, min: 220, collapsible: true, resizable: true, color: "#a6b6ac" },
  { key: "dev", label: "Dev draft", fr: 0.8, min: 160, collapsible: true, resizable: true, color: "#c2b18e" },
  { key: "ai", label: "AI draft", fr: 0.9, min: 180, collapsible: true, resizable: true, color: "#9cbbe0" },
  { key: "tr", label: "Translation · JA", fr: 1.2, min: 240, resizable: true, color: "#8ccfa7" },
  { key: "st", label: "", fixed: 66 },
];

const COLLAPSED_WIDTH = 30;
const STATUS_LABEL = { pending: "Untranslated", draft: "Draft only", translated: "Translated" } as const;

const FILTERS: { id: RowFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "todo", label: "To do" },
  { id: "draft", label: "Draft only" },
  { id: "translated", label: "Translated" },
  { id: "locked", label: "Locked" },
  { id: "warnings", label: "" },
];

const isResizable = (key: ColumnKey): key is ResizableColumn => key === "speaker" || key === "src" || key === "dev" || key === "ai" || key === "tr";

/** Grid template for the Matrix. Collapsed columns become a thin strip; dragged columns get a px width. */
function columnTemplate(prefs: MoriPrefs, overrides: Partial<Record<ResizableColumn, number>> = {}): string {
  return COLUMN_DEFS.map(def => {
    if (isResizable(def.key)) {
      const pref = prefs.columns[def.key];
      if (pref.collapsed) return `${COLLAPSED_WIDTH}px`;
      const width = overrides[def.key] ?? pref.width;
      if (width) return `${width}px`;
    }
    if (def.fixed) return `${def.fixed}px`;
    return `minmax(${def.min ?? 0}px, ${def.fr ?? 1}fr)`;
  }).join(" ");
}

function minimumWidth(prefs: MoriPrefs): number {
  return COLUMN_DEFS.reduce((sum, def) => {
    if (isResizable(def.key) && prefs.columns[def.key].collapsed) return sum + COLLAPSED_WIDTH;
    if (isResizable(def.key) && prefs.columns[def.key].width) return sum + (prefs.columns[def.key].width ?? 0);
    return sum + (def.fixed ?? def.min ?? 0);
  }, 0);
}

/** The one editor on screen: grows with its text and keeps the caret where the user left it. */
export function LineEditor({ value, onChange, className = "editor" }: { value: string; onChange: (value: string) => void; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || className !== "editor") return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value, className]);
  return (
    <textarea
      ref={ref}
      data-editor
      className={className}
      rows={1}
      lang="ja"
      spellCheck={false}
      autoComplete="off"
      placeholder="Type your translation…"
      value={value}
      onChange={event => onChange(event.target.value)}
    />
  );
}

function LineRow({ row, dupes, active }: { row: MoriRow; dupes: string[]; active: boolean }) {
  const { project, actions, prefs, bindings, select, adopt, toggleLock, openPop, setColumn } = useApp();
  const character = project.characters.find(c => c.id === row.characterId);
  const status = statusOf(row);
  const warnings = checkRow(row, project.glossary);
  const glossary = project.glossary;

  const collapsedCell = (key: ColumnKey, color: string | undefined, label: string, has: boolean) => (
    <div
      key={key}
      className="c c-collapsed"
      title={`${label} — click to expand`}
      onClick={event => { event.stopPropagation(); if (isResizable(key)) setColumn(key, { collapsed: false }); }}
    >
      {has && <span className="cdot" style={{ background: color ?? "var(--text-3)" }} />}
    </div>
  );

  const cell = (def: ColumnDef) => {
    if (isResizable(def.key) && prefs.columns[def.key].collapsed) {
      const has = def.key === "speaker" ? !!row.characterId
        : def.key === "src" ? !!row.source
        : def.key === "dev" ? !!row.legacy
        : !!row.ai;
      return collapsedCell(def.key, def.color, def.label, has);
    }
    switch (def.key) {
      case "id":
        return (
          <div key="id" className="c c-id">
            <span className={`sdot ${status}`} title={STATUS_LABEL[status]} />
            <span>{row.id}</span>
            {dupes.length > 0 && <span className="dup" title={`Same English as ${dupes.join(", ")}`}>={dupes.length}</span>}
          </div>
        );
      case "speaker":
        return (
          <div key="speaker" className="c c-speaker">
            <button
              type="button"
              className={`spk${character ? "" : " none"}`}
              data-spk={row.id}
              style={character ? cssVar("--c", characterColor(character.id)) : undefined}
              onClick={event => { event.stopPropagation(); openPop({ kind: "speaker", anchor: event.currentTarget, rowId: row.id, width: 290 }); }}
            >
              <span className="dotc" />
              <span>{character ? character.name : "Unassigned"}</span>
              <Icon name="chevron-down" size="xs" />
            </button>
          </div>
        );
      case "src":
        return <div key="src" className="c c-src en"><Marked text={row.source} glossary={glossary} /></div>;
      case "dev":
      case "ai": {
        const text = def.key === "ai" ? row.ai : row.legacy;
        const shortcut = keyLabel(bindings[def.key === "ai" ? "useAI" : "useDev"]);
        return (
          <div key={def.key} className={`c c-${def.key} ja`}>
            {text ? (
              <>
                <Marked text={text} glossary={glossary} />
                {!row.isLocked && (
                  <button
                    type="button"
                    className="use"
                    title={`Use as translation${shortcut ? ` (${shortcut})` : ""}. Your current text is kept in Versions.`}
                    onClick={event => { event.stopPropagation(); adopt(row.id, text, def.key === "ai" ? "AI draft" : "Dev draft"); }}
                  >
                    <Icon name="use" size="sm" />
                  </button>
                )}
              </>
            ) : (
              <span className="empty">—</span>
            )}
          </div>
        );
      }
      case "tr":
        if (active && !row.isLocked) {
          return (
            <div key="tr" className="c c-tr editing">
              <LineEditor value={row.final} onChange={value => actions.updateRow(row.id, current => editFinalText(current, value))} />
            </div>
          );
        }
        return (
          <div key="tr" className="c c-tr ja">
            {row.final ? <Marked text={row.final} glossary={glossary} /> : <span className="empty">{row.isLocked ? "Locked · empty" : "—"}</span>}
          </div>
        );
      case "st":
        return (
          <div key="st" className="c c-st">
            {warnings.length > 0 && (
              <span className="warnb" title={warnings.map(w => w.message).join("\n")}>
                <Icon name="alert" size="xs" />{warnings.length}
              </span>
            )}
            <button
              type="button"
              className={`ib lockb${row.isLocked ? " locked" : ""}`}
              title={`${row.isLocked ? "Unlock" : "Lock as final"} (${keyLabel(bindings.lock)})`}
              onClick={event => { event.stopPropagation(); toggleLock(row.id); }}
            >
              <Icon name={row.isLocked ? "lock" : "unlock"} size="sm" />
            </button>
          </div>
        );
    }
  };

  return (
    <div
      className={`row${active ? " active" : ""}${row.isLocked ? " locked" : ""}`}
      data-row-id={row.id}
      onClick={event => {
        // Clicking the translation of another line moves there and focuses its editor.
        if (active || window.getSelection()?.toString()) return;
        select(row.id, !!(event.target as HTMLElement).closest(".c-tr"));
      }}
    >
      {COLUMN_DEFS.map(def => cell(def))}
    </div>
  );
}

export function MatrixScreen() {
  const { project, view, setView, visible, activeId, prefs, setColumn, setPrefs, bindings, openPop, folded, toggleFold, go } = useApp();
  const matrixRef = useRef<HTMLDivElement>(null);
  const glossary = project.glossary;
  const activeRow = project.rows.find(row => row.id === activeId);

  const scope = useMemo(
    () => (view.file ? project.rows.filter(row => row.sourceFile === view.file) : project.rows),
    [project.rows, view.file],
  );
  const counts = useMemo(() => {
    const result = {} as Record<RowFilter, number>;
    for (const filter of FILTERS) result[filter.id] = scope.filter(row => matchesFilter(row, filter.id, glossary)).length;
    return result;
  }, [scope, glossary]);

  // Source IDs of other lines with the same English, for the "=2" badge.
  const dupeIndex = useMemo(() => {
    const index = new Map<string, string[]>();
    for (const row of project.rows) {
      const key = row.source.trim();
      index.set(key, [...(index.get(key) ?? []), row.id]);
    }
    return index;
  }, [project.rows]);

  const groups = useMemo(() => {
    const byFile = new Map<string, MoriRow[]>();
    for (const row of visible) {
      const file = row.sourceFile ?? "";
      byFile.set(file, [...(byFile.get(file) ?? []), row]);
    }
    return [...byFile].map(([file, rows]) => ({ file, rows }));
  }, [visible]);

  // Moving to a line inside a folded group opens that group. It runs only when the active line
  // changes, so folding a group by hand is not undone.
  useEffect(() => {
    if (!activeRow) return;
    const key = `group:${activeRow.sourceFile ?? ""}`;
    if (folded.has(key)) toggleFold(key);
  }, [activeId]);

  const startResize = (key: ResizableColumn, event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const matrix = matrixRef.current;
    const header = event.currentTarget.parentElement;
    if (!matrix || !header) return;
    const handle = event.currentTarget;
    const startWidth = header.getBoundingClientRect().width;
    const startX = event.clientX;
    const min = COLUMN_DEFS.find(def => def.key === key)?.min ?? 96;
    let width = startWidth;
    handle.classList.add("drag");
    document.body.style.cursor = "col-resize";
    const move = (moveEvent: PointerEvent) => {
      width = Math.max(min, Math.round(startWidth + moveEvent.clientX - startX));
      const overrides: Partial<Record<ResizableColumn, number>> = {};
      overrides[key] = width;
      // Only the template changes while dragging; the preference is written once on release.
      matrix.style.setProperty("--cols", columnTemplate(prefs, overrides));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      handle.classList.remove("drag");
      document.body.style.cursor = "";
      setColumn(key, { width });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const speakerLabel = view.speaker === "any" ? "Any speaker"
    : view.speaker === "none" ? "Unassigned"
    : project.characters.find(c => c.id === view.speaker)?.name ?? "Speaker";

  return (
    <>
      <div className="toolbar">
        {view.file && (
          <span className="scope">
            <Icon name="file" size="xs" />{view.file}
            <button type="button" title="Show all files" aria-label="Show all files" onClick={() => setView({ file: null })}>
              <Icon name="x" size="xs" />
            </button>
          </span>
        )}
        <div className="seg" role="group" aria-label="Filter lines">
          {FILTERS.map(filter => (
            <button
              type="button"
              key={filter.id}
              className={view.filter === filter.id ? "on" : ""}
              title={filter.id === "warnings" ? "Has warnings" : undefined}
              onClick={() => setView({ filter: filter.id })}
            >
              {filter.id === "warnings" && <Icon name="alert" size="xs" />}
              {filter.label}
              <span className={`n tabnum${filter.id === "warnings" && counts.warnings ? " warn" : ""}`}>{counts[filter.id]}</span>
            </button>
          ))}
        </div>
        <div className="grow" />
        <label className="field" style={{ width: 210 }}>
          <Icon name="search" size="sm" />
          <input id="mori-find" value={view.query} placeholder="Find in lines" onChange={event => setView({ query: event.target.value })} />
          {bindings.find && <KeyCaps binding={bindings.find} />}
        </label>
        <button
          type="button"
          className={`btn${view.speaker !== "any" ? " on" : ""}`}
          onClick={event => openPop({ kind: "speakerFilter", anchor: event.currentTarget, align: "end", width: 230 })}
        >
          <Icon name="users" size="sm" />
          <span>{speakerLabel}</span>
          <Icon name="chevron-down" size="xs" />
        </button>
        <button
          type="button"
          className="btn icon"
          title="Columns & density"
          aria-label="Columns and density"
          onClick={event => openPop({ kind: "columns", anchor: event.currentTarget, align: "end", width: 260 })}
        >
          <Icon name="columns" />
        </button>
        <button
          type="button"
          className={`btn icon${prefs.inspectorOpen ? " on" : ""}`}
          title={`Inspector (${keyLabel(bindings.inspector)})`}
          aria-label="Show or hide inspector"
          onClick={() => setPrefs({ inspectorOpen: !prefs.inspectorOpen })}
        >
          <Icon name="panel" />
        </button>
      </div>

      <div className="scroll">
        <div
          ref={matrixRef}
          className={`matrix${prefs.density === "compact" ? " compact" : ""}`}
          style={{ ...cssVar("--cols", columnTemplate(prefs)), minWidth: minimumWidth(prefs) }}
        >
          <div className="hrow">
            {COLUMN_DEFS.map(def => {
              if (isResizable(def.key) && prefs.columns[def.key].collapsed) {
                return (
                  <div
                    key={def.key}
                    className="hc collapsed"
                    title={`${def.label} — click to expand`}
                    onClick={() => setColumn(def.key as ResizableColumn, { collapsed: false })}
                  >
                    <span className="sw" style={cssVar("--c", def.color ?? "var(--text-4)")} />
                    <Icon name="expand" size="xs" />
                  </div>
                );
              }
              return (
                <div key={def.key} className="hc">
                  {def.color && <span className="sw" style={cssVar("--c", def.color)} />}
                  <span className="lbl">{def.label}</span>
                  {def.collapsible && isResizable(def.key) && (
                    <button
                      type="button"
                      className="col-x"
                      title="Collapse column"
                      aria-label={`Collapse ${def.label}`}
                      onClick={() => setColumn(def.key as ResizableColumn, { collapsed: true })}
                    >
                      <Icon name="collapse" size="xs" />
                    </button>
                  )}
                  {def.resizable && isResizable(def.key) && (
                    <span
                      className="resizer"
                      title="Drag to resize · double-click to reset"
                      onPointerDown={event => startResize(def.key as ResizableColumn, event)}
                      onDoubleClick={() => setColumn(def.key as ResizableColumn, { width: null })}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {!visible.length && (
            <div className="mx-empty">
              <b>No lines match</b>
              Try another filter or clear the search.
            </div>
          )}

          {groups.map(group => {
            const key = `group:${group.file}`;
            const total = project.rows.filter(row => (row.sourceFile ?? "") === group.file);
            const done = total.filter(row => statusOf(row) === "translated").length;
            const slash = group.file.lastIndexOf("/");
            const folder = slash >= 0 ? group.file.slice(0, slash + 1) : "";
            const name = group.file.slice(slash + 1) || "No source file";
            return (
              <section key={group.file} className={`grp${folded.has(key) ? " closed" : ""}`}>
                <div className="grp-h" onClick={() => toggleFold(key)}>
                  <Icon name="chevron-down" size="xs" className="chev" />
                  <Icon name="file" size="sm" />
                  <span>{folder}<b>{name}</b></span>
                  <span>· {group.rows.length === total.length ? `${total.length} lines` : `${group.rows.length} of ${total.length} lines`}</span>
                  <span className="prog">
                    <span className="tabnum">{done} / {total.length}</span>
                    <span className="bar"><span style={{ width: `${total.length ? (100 * done) / total.length : 0}%`, background: "var(--moss)" }} /></span>
                  </span>
                </div>
                {group.rows.map(row => (
                  <LineRow
                    key={row.id}
                    row={row}
                    active={row.id === activeId}
                    dupes={(dupeIndex.get(row.source.trim()) ?? []).filter(id => id !== row.id)}
                  />
                ))}
              </section>
            );
          })}
        </div>
      </div>
    </>
  );
}
