import { useApp } from "./app-context.ts";
import { Icon } from "./Icons.tsx";
import { LineEditor } from "./Matrix.tsx";
import { Marked } from "./Marked.tsx";
import { checkRow, glossaryHits, statusOf } from "./insights.ts";
import { editFinalText } from "./model.ts";
import { keyLabel } from "./shortcuts.ts";
import { characterColor, cssVar } from "./theme.ts";

const STATUS_LABEL = { pending: "Untranslated", draft: "Draft only", translated: "Translated" } as const;

/** One line at a time with a large editor. Same keys as the Matrix: Alt+↑/↓ moves, Ctrl+Enter keeps and continues. */
export function FocusScreen() {
  const { project, activeRow, actions, adopt, toggleLock, runAction, step, bindings, visible } = useApp();
  if (!activeRow) {
    return <div className="screen"><div className="mx-empty"><b>No line selected</b>Pick a line in the Matrix to focus on it.</div></div>;
  }
  const row = activeRow;
  const status = statusOf(row);
  const glossary = project.glossary;
  const character = project.characters.find(c => c.id === row.characterId);
  const warnings = checkRow(row, glossary);
  const terms = glossaryHits(row.source, glossary);
  const index = visible.findIndex(item => item.id === row.id);

  return (
    <div className="focus-wrap">
      <div className="focus-main">
        <div className="ih-row">
          <span className="mono">{row.id}</span>
          <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>
          {row.isLocked && <span className="pill lock"><Icon name="lock" size="xs" />Locked</span>}
          <span className="grow" />
          <span className="muted tabnum" style={{ fontSize: 11.5 }}>{index + 1} / {visible.length}</span>
          <button type="button" className="ib" title={`Previous line (${keyLabel(bindings.prev)})`} aria-label="Previous line" onClick={() => step(-1)}>
            <Icon name="chevron-up" size="sm" />
          </button>
          <button type="button" className="ib" title={`Next line (${keyLabel(bindings.next)})`} aria-label="Next line" onClick={() => step(1)}>
            <Icon name="chevron-down" size="sm" />
          </button>
        </div>

        <div className="focus-src en"><Marked text={row.source} glossary={glossary} /></div>

        {row.isLocked ? (
          <div className="focus-src ja">{row.final || <span className="empty">Locked · empty</span>}</div>
        ) : (
          <LineEditor
            className="editor focus-edit"
            value={row.final}
            onChange={value => actions.updateRow(row.id, current => editFinalText(current, value))}
          />
        )}

        <div className="focus-foot">
          <button type="button" className="btn outline" onClick={() => toggleLock(row.id)}>
            <Icon name={row.isLocked ? "lock" : "unlock"} size="sm" />
            {row.isLocked ? "Unlock" : "Lock as final"}
          </button>
          <span className="grow" />
          <button type="button" className="btn primary" onClick={() => runAction("keepNext")}>
            <Icon name="arrow" size="sm" />Keep &amp; next unfinished
          </button>
        </div>
        {warnings.length > 0 && (
          <p className="imp-err" style={{ margin: 0 }}>
            <Icon name="alert" size="sm" />
            <span>{warnings.map(w => w.message).join(" · ")}</span>
          </p>
        )}
      </div>

      <div className="focus-side">
        <div className="ref-card">
          <div className="ref-card-h">
            {character && <span className="avl" style={cssVar("--c", characterColor(character.id))}>{character.name.charAt(0)}</span>}
            <b style={{ color: "var(--text)", fontWeight: 600 }}>{character ? character.name : "No speaker"}</b>
          </div>
          <p className="ja" style={{ fontSize: 13, color: "var(--text-2)" }}>{character?.description || "Voice notes appear here once a speaker is assigned."}</p>
        </div>

        <div className="ref-card">
          <div className="ref-card-h">
            <span>Dev draft</span>
            {row.legacy && !row.isLocked && (
              <button type="button" className="btn xs outline" onClick={() => adopt(row.id, row.legacy ?? "", "Dev draft")}>Use</button>
            )}
          </div>
          <div className="ja">{row.legacy ? <Marked text={row.legacy} glossary={glossary} /> : <span className="empty">None</span>}</div>
        </div>

        <div className="ref-card">
          <div className="ref-card-h">
            <span>AI draft</span>
            {row.ai && !row.isLocked && (
              <button type="button" className="btn xs outline" onClick={() => adopt(row.id, row.ai ?? "", "AI draft")}>Use</button>
            )}
          </div>
          <div className="ja">{row.ai ? <Marked text={row.ai} glossary={glossary} /> : <span className="empty">None</span>}</div>
        </div>

        {terms.length > 0 && (
          <div className="ref-card">
            <div className="ref-card-h"><span>Glossary in this line</span></div>
            {terms.map(term => (
              <div key={term.id} className="gl" style={{ padding: "4px 0" }}>
                <span>{term.en}</span>
                <Icon name="arrow" size="xs" />
                <span className="gl-ja">{term.jp}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
