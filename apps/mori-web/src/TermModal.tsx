import { useMemo, useState } from "react";
import { useApp, type ModalState } from "./app-context.ts";
import { Icon } from "./Icons.tsx";
import { adoptText, findUsages, termImpact } from "./insights.ts";

type TermModalProps = Extract<ModalState, { kind: "term" }>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Shows `text` with each occurrence of `needle` wrapped in a mark of class `cls`. */
function Marks({ text, needle, cls }: { text: string; needle: string; cls: string }) {
  if (!needle) return <>{text}</>;
  const parts = text.split(needle);
  return <>{parts.map((part, index) => <span key={index}>{index > 0 && <mark className={cls}>{needle}</mark>}{part}</span>)}</>;
}

/**
 * Add a glossary term, then see how it is used across the project.
 * Opened from a selection in the Matrix, the Glossary screen, or the Inspector. When the term's
 * Japanese changed, it also offers to replace the old Japanese in the translator's own lines,
 * one approved list at a time. Locked lines and AI drafts are never edited here.
 */
export function TermModal(props: TermModalProps) {
  const { project, actions, closeModal, setView, go, toast, drafter } = useApp();
  const [termId, setTermId] = useState(props.termId);
  const [previous, setPrevious] = useState(props.previousJp ?? "");
  const [en, setEn] = useState(props.en ?? "");
  const [jp, setJp] = useState(props.jp ?? "");
  const [note, setNote] = useState("");
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [replaced, setReplaced] = useState(0);

  const source = props.rowId ? project.rows.find(row => row.id === props.rowId) : undefined;
  const existing = project.glossary.find(term => term.en.trim() && term.en.trim().toLowerCase() === en.trim().toLowerCase());
  const term = termId ? project.glossary.find(entry => entry.id === termId) : undefined;
  const impact = useMemo(() => term && termImpact(project.rows, term, previous), [project.rows, term, previous]);

  const save = () => {
    const fields = { en: en.trim(), jp: jp.trim() };
    if (!fields.en) return;
    if (existing) {
      actions.updateGlossary(existing.id, { ...fields, ...(note.trim() ? { explanation: note.trim() } : {}) });
      if (existing.jp.trim() && existing.jp.trim() !== fields.jp) setPrevious(existing.jp.trim());
      setTermId(existing.id);
    } else {
      setTermId(actions.addGlossary({ ...fields, explanation: note.trim() }));
    }
  };

  if (!termId) {
    const usage = findUsages(project.rows, en).total;
    return (
      <>
        <div className="m-head">
          <Icon name="book" />
          <h2>Add to glossary</h2>
          <span className="grow" />
          <button type="button" className="ib" aria-label="Close" onClick={closeModal}><Icon name="x" size="sm" /></button>
        </div>
        <form className="m-body tm-form" id="term-form" onSubmit={event => { event.preventDefault(); save(); }}>
          {source && (
            <div className="tm-line">
              <span className="mono">{source.id}</span>
              <p>{source.source}</p>
              {(source.final || source.ai) && <p className="ja" lang="ja">{source.final || source.ai}</p>}
            </div>
          )}
          <label className="field-l">English
            <input autoFocus={!en} value={en} onChange={event => setEn(event.target.value)} placeholder="e.g. Ember" />
          </label>
          <label className="field-l">Japanese
            <input autoFocus={!!en && !jp} className="ja" lang="ja" value={jp} onChange={event => setJp(event.target.value)} placeholder="e.g. 残り火" />
          </label>
          <label className="field-l">Note <span className="muted">optional</span>
            <input value={note} onChange={event => setNote(event.target.value)} placeholder="When to use it, or what to avoid" />
          </label>
          <p className="tm-hint">
            {!en.trim() ? "Plurals and possessives match too: “lantern” also finds “lanterns”."
              : existing ? <>Already in the glossary as <b className="ja" lang="ja">{existing.jp || "no Japanese yet"}</b>. Saving updates it.</>
              : `Used in ${plural(usage, "line")}.`}
          </p>
        </form>
        <div className="m-foot">
          <span className="grow" />
          <button type="button" className="btn outline sm" onClick={closeModal}>Cancel</button>
          <button type="submit" form="term-form" className="btn primary sm" disabled={!en.trim()}>{existing ? "Update term" : "Add term"}</button>
        </div>
      </>
    );
  }

  if (!term || !impact) return null;
  const termJp = term.jp.trim();
  const chosen = impact.replaceable.filter(({ row }) => !skipped.has(row.id));
  const review = (filter: "all" | "warnings") => {
    setView({ term: term.id, filter, file: null, query: "" });
    go("matrix");
    closeModal();
  };
  const replace = () => {
    for (const { row } of chosen) {
      actions.updateRow(row.id, current => current.isLocked ? current : adoptText(current, current.final.split(previous).join(termJp)));
    }
    setReplaced(count => count + chosen.length);
    toast(`Replaced ${previous} with ${termJp} in ${plural(chosen.length, "line")}. Earlier text is in Versions.`);
  };
  const toggle = (id: string) => setSkipped(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <>
      <div className="m-head">
        <Icon name="book" />
        <h2>{term.en} <Icon name="arrow" size="xs" /> <span className="ja" lang="ja">{termJp || "no Japanese yet"}</span></h2>
        <span className="grow" />
        <button type="button" className="ib" aria-label="Close" onClick={closeModal}><Icon name="x" size="sm" /></button>
      </div>
      <div className="m-body">
        <p className="tm-lead">
          {impact.lines.length ? <>“{term.en}” appears in <b>{plural(impact.lines.length, "line")}</b>.</> : <>“{term.en}” isn’t in any line yet. New lines that use it are checked.</>}
        </p>
        {impact.lines.length > 0 && (
          <ul className="impact">
            {termJp && impact.consistent.length > 0 && <li className="ok"><Icon name="check" size="sm" /><span><b>{impact.consistent.length}</b> already use <span className="ja" lang="ja">{termJp}</span></span></li>}
            {impact.mismatched.length > 0 && (
              <li className="warn">
                <Icon name="alert" size="sm" />
                <span><b>{impact.mismatched.length}</b> of your translations don’t</span>
              </li>
            )}
            {impact.locked.length > 0 && <li><Icon name="lock" size="sm" /><span><b>{impact.locked.length}</b> locked {impact.locked.length === 1 ? "line doesn’t. Mori leaves it as it is." : "lines don’t. Mori leaves them as they are."}</span></li>}
            {impact.drafts.length > 0 && (
              <li><Icon name="sparkle" size="sm" /><span><b>{impact.drafts.length}</b> AI {impact.drafts.length === 1 ? "draft doesn’t" : "drafts don’t"}. {drafter.phase === "off" ? "They keep the old wording until redrafted." : "They are redrafted as you get near them."}</span></li>
            )}
            {impact.untranslated.length > 0 && <li><Icon name="file" size="sm" /><span><b>{impact.untranslated.length}</b> not translated yet{termJp ? <>. New AI drafts use <span className="ja" lang="ja">{termJp}</span></> : ""}.</span></li>}
          </ul>
        )}

        {previous && termJp && (impact.replaceable.length > 0 || replaced > 0) && (
          <div className="replace">
            <h3>Replace <span className="ja" lang="ja">{previous}</span> with <span className="ja" lang="ja">{termJp}</span>?</h3>
            {impact.replaceable.length ? (
              <>
                <p className="muted">In {plural(impact.replaceable.length, "of your translations", "of your translations")}. Untick any line to keep it. Your current text stays in Versions; locked lines are skipped.</p>
                <div className="rep-list">
                  {impact.replaceable.map(({ row, after }) => (
                    <label key={row.id} className="rep">
                      <input type="checkbox" checked={!skipped.has(row.id)} onChange={() => toggle(row.id)} />
                      <span className="mono">{row.id}</span>
                      <span className="ja rep-t" lang="ja">
                        <span className="before"><Marks text={row.final} needle={previous} cls="del" /></span>
                        <span className="after"><Marks text={after} needle={termJp} cls="ins" /></span>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            ) : <p className="muted">Done: replaced in {plural(replaced, "line")}.</p>}
          </div>
        )}
      </div>
      <div className="m-foot">
        {impact.lines.length > 0 && <button type="button" className="btn outline sm" onClick={() => review("all")}>{impact.lines.length === 1 ? "Show the line" : `Show all ${impact.lines.length} lines`}</button>}
        <span className="grow" />
        {chosen.length > 0 && previous && <button type="button" className="btn primary sm" onClick={replace}>Replace in {plural(chosen.length, "line")}</button>}
        {impact.mismatched.length > 0 && !chosen.length && <button type="button" className="btn primary sm" onClick={() => review("warnings")}>Review {plural(impact.mismatched.length, "line")}</button>}
        <button type="button" className={`btn sm ${impact.mismatched.length || chosen.length ? "outline" : "primary"}`} onClick={closeModal}>Done</button>
      </div>
    </>
  );
}
