import { useEffect, useMemo, useRef, useState } from "react";
import { AI_BATCH_LIMIT, batchTranslationPrompt, canDraft, parseBatchReply, withAIDraft } from "./ai-batch.ts";
import { nativeMori } from "./backend.ts";
import { draftMissesGlossary, glossaryHits } from "./insights.ts";
import type { MoriProject, MoriRow } from "./model.ts";
import { projectForTranslation, type MoriPrefs } from "./prefs.ts";
import type { MoriActions } from "./store.ts";

const MODEL = "gpt-6-luna";
const EFFORT = "low";

export interface DraftAheadState {
  /** "off" when the setting is 0 or there is no desktop host to run Codex. */
  phase: "off" | "drafting" | "ready" | "paused" | "error";
  /** Lines ahead that need an AI draft, and how many of them have a usable one. */
  wanted: number;
  ready: number;
  error: string | null;
  setPaused: (paused: boolean) => void;
  /** Clears an error and tries again. */
  retry: () => void;
}

/**
 * Keeps AI drafts ready for the next `prefs.draftAhead` lines after the current one, in project order.
 * Drafts are written to `row.ai` only, so the translator's own text is never changed. A draft that
 * misses a glossary term is redone once for that term, so glossary edits flow into upcoming drafts.
 */
export function useDraftAhead(project: MoriProject | null, activeId: string | null, prefs: MoriPrefs, actions: MoriActions): DraftAheadState {
  const native = nativeMori();
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each line is tried once per English text and glossary wording, so a stubborn draft can't loop.
  const attempted = useRef(new Set<string>());
  const projectRef = useRef(project);
  projectRef.current = project;

  const glossary = prefs.glossaryEnabled ? project?.glossary ?? [] : [];
  const keyOf = (row: MoriRow) => `${project?.id}\n${row.id}\n${row.source}\n${glossaryHits(row.source, glossary).map(t => `${t.en}=${t.jp}`).join("|")}`;

  const plan = useMemo(() => {
    if (!project || !prefs.draftAhead) return { wanted: [] as MoriRow[], todo: [] as MoriRow[] };
    const start = Math.max(0, project.rows.findIndex(row => row.id === activeId));
    const wanted = project.rows.slice(start, start + prefs.draftAhead).filter(canDraft);
    const todo = wanted.filter(row => !row.ai?.trim() || draftMissesGlossary(row, glossary));
    return { wanted, todo };
  }, [project, activeId, prefs.draftAhead, glossary]);

  useEffect(() => setError(null), [project?.id]);

  useEffect(() => {
    if (!native || !project || paused || busy || error) return;
    const batch = plan.todo.filter(row => !attempted.current.has(keyOf(row))).slice(0, AI_BATCH_LIMIT);
    if (!batch.length) return;
    const keys = batch.map(keyOf);
    keys.forEach(key => attempted.current.add(key));
    const ids = batch.map(row => row.id);
    const projectId = project.id;
    setBusy(true);
    void (async () => {
      try {
        const prompt = batchTranslationPrompt(projectForTranslation(project, prefs), batch);
        const result = await native.codexTranslate({ mode: ids.length === 1 ? "single" : "batch", ids, prompt });
        if (result.model !== MODEL || result.reasoningEffort !== EFFORT) throw Error("Codex answered with an unexpected model. No drafts were changed.");
        const drafts = parseBatchReply(result.text, ids);
        if (projectRef.current?.id !== projectId) return;
        for (const { id, japanese } of drafts) actions.updateRow(id, row => withAIDraft(row, japanese));
      } catch (cause) {
        // Let the same lines be tried again after the translator retries.
        keys.forEach(key => attempted.current.delete(key));
        setError(cause instanceof Error ? cause.message : "Codex drafting failed.");
      } finally {
        setBusy(false);
      }
    })();
  }, [native, project, plan, paused, busy, error, prefs]);

  const ready = plan.wanted.length - plan.todo.length;
  const phase: DraftAheadState["phase"] = !native || !prefs.draftAhead ? "off"
    : error ? "error" : paused ? "paused" : busy ? "drafting" : "ready";
  return { phase, wanted: plan.wanted.length, ready, error, setPaused, retry: () => setError(null) };
}
