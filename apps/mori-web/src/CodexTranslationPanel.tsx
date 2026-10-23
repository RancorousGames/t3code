import { useMemo, useState } from "react";
import { useApp } from "./app-context.ts";
import { nativeMori } from "./backend.ts";
import { batchTranslationPrompt, nextDraftCandidates, parseBatchReply } from "./ai-batch.ts";
import { checkRow } from "./insights.ts";

const MODEL = "gpt-6-luna";
const EFFORT = "low";

/** A short-lived translation-only Codex subscription run. All generation
 * and model selection happens in the native host, never in renderer JS. */
export function CodexTranslationPanel() {
  const { project, activeRow, actions, toast } = useApp();
  const native = nativeMori();
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<{ id: string; japanese: string }[] | null>(null);
  const eligible = useMemo(() => nextDraftCandidates(project, 5), [project]);
  const available = !!native;
  const invoke = async (ids: string[]) => {
    if (!native || !ids.length || running) return;
    const selected = ids.map(id => project.rows.find(row => row.id === id));
    if (selected.some(row => !row || row.isLocked || row.final.trim())) {
      setStatus("All chosen lines must be unlocked with no curated translation.");
      return;
    }
    const rows = selected.filter(row => row !== undefined);
    const prompt = batchTranslationPrompt(project, rows);
    setRunning(true); setStatus(`Codex Luna 6, low reasoning: translating ${ids.length} line(s)…`);
    setPreview(null);
    try {
      const result = await native.codexTranslate({mode: ids.length === 1 ? "single" : "batch", ids, prompt});
      if (result.model !== MODEL || result.reasoningEffort !== EFFORT) {
        throw Error("Unexpected model or reasoning level. No drafts were changed.");
      }
      const parsed = parseBatchReply(result.text, ids);
      setPreview(parsed);
      setStatus(`${parsed.length} ${MODEL} / ${EFFORT} proposal(s) ready. Review and apply to AI drafts below.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Codex translation failed."); }
    finally { setRunning(false); }
  };
  const save = () => {
    if (!preview || running) return;
    const lockedNow = preview.find(({id}) => project.rows.find(row => row.id === id)?.isLocked);
    if (lockedNow) { setStatus(`The row ${lockedNow.id} was locked while translating. No drafts were changed.`); return; }
    if (!window.confirm(`Save ${preview.length} Codex Luna 6 (low) proposal(s) as AI drafts? Current human translations remain untouched.`)) return;
    for (const { id, japanese } of preview) {
      actions.updateRow(id, row => {
        if (row.isLocked) return row;
        return {
          ...row, ai: japanese,
          status: row.final.trim() ? "translated" : "draft",
          ...(row.ai && row.ai !== japanese ? {
            history: [...(row.history ?? []), { type: "ai" as const, text: row.ai, timestamp: Date.now() }],
          } : {}),
        };
      });
    }
    toast(`Saved ${preview.length} Codex Luna 6 (low) AI draft(s); no curated translation was overwritten.`);
    setPreview(null);
    setStatus("Drafts saved to the local project.");
  };

  return <section className="mori-codex-panel">
    <div className="mori-codex-label">
      <div><b>Translation engine: Codex Luna 6</b><span>Reasoning: low · ChatGPT subscription sign-in via installed Codex CLI</span></div>
      <span className="grow" />
      <span className="mori-codex-badge">LOW COST TEST MODE</span>
    </div>
    <div className="mori-codex-actions">
      <button type="button" className="btn primary sm" disabled={!available || !activeRow || !!activeRow?.isLocked || !!activeRow?.final.trim() || running}
        onClick={() => activeRow && void invoke([activeRow.id])}>Translate selected line</button>
      <button type="button" className="btn outline sm" disabled={!available || !eligible.length || running}
        onClick={() => void invoke(eligible.map(row => row.id))}>Draft up to 5 unfinished lines</button>
      <span className="muted" style={{ fontSize: 12 }}>
        {activeRow ? `Selected: ${activeRow.id}` : "Select a line in Matrix first."}
      </span>
      <span className="grow" />
      {running && <button type="button" className="btn outline sm" disabled title="Current run finishes or times out automatically">Working…</button>}
    </div>
    {status && <p className="muted" role="status" style={{fontSize:12}}>{status}</p>}
    {!available && <p className="muted" style={{fontSize:12}}>Install the Monku desktop application to run subscription translation through Codex.</p>}
    {preview && <div className="mori-codex-results">
      <b>Review suggested Japanese</b>
      {preview.map(({id,japanese}) => <div key={id} className="mori-codex-suggestion">
        <b>{id}</b><div lang="ja">{japanese}</div>
        {(() => {
          const row = project.rows.find(row => row.id === id);
          if (!row) return null;
          const check = checkRow({ ...row, final: japanese }, project.glossary);
          return check.length ? <small>{check.map(w => w.message).join(" · ")}</small> : null;
        })()}
      </div>)}
      <div className="mori-codex-actions">
        <button type="button" className="btn primary sm" onClick={save}>Accept into AI drafts</button>
        <button type="button" className="btn outline sm" onClick={() => setPreview(null)}>Discard proposals</button>
      </div>
    </div>}
    <small className="muted">Only Codex Luna 6 at low reasoning is used by these translation buttons. No fallback to other models. Locked and curated text stays protected.</small>
  </section>;
}
