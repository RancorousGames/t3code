import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MoriCharacter, MoriGlossaryEntry, MoriProject, MoriRow } from "./model.ts";
import { withSpeaker } from "./insights.ts";
import { saveProject } from "./library.ts";

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

export interface MoriActions {
  updateProject: (update: (current: MoriProject) => MoriProject) => void;
  updateRow: (id: string, update: (row: MoriRow) => MoriRow) => void;
  renameProject: (name: string) => void;
  setContext: (field: "global" | "project", text: string) => void;
  addCharacter: (fields?: Partial<MoriCharacter>) => string;
  updateCharacter: (id: string, patch: Partial<MoriCharacter>) => void;
  /** Removes the definition and unassigns its lines. */
  removeCharacter: (id: string) => void;
  addGlossary: (fields?: Partial<MoriGlossaryEntry>) => string;
  updateGlossary: (id: string, patch: Partial<MoriGlossaryEntry>) => void;
  removeGlossary: (id: string) => void;
}

const slugId = (name: string) =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "CHAR";

const AUTOSAVE_DELAY_MS = 400;
const RETRY_DELAY_MS = 5000;

/**
 * The open project plus autosave. Edits are queued per project and written after a short pause,
 * so switching projects can't drop the last edits. A failed write goes back in the queue.
 */
export function useProjectStore() {
  const [project, setProject] = useState<MoriProject | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  // Projects handed in by load() are already on disk and must not be queued again.
  const loadedRef = useRef<MoriProject | null>(null);
  const queue = useRef(new Map<string, MoriProject>());
  const timer = useRef<number | undefined>(undefined);
  const editGeneration = useRef(0);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const batch = [...queue.current.values()];
    const generationAtFlush = editGeneration.current;
    queue.current.clear();
    if (!batch.length) return;
    setSave({ kind: "saving" });
    for (const next of batch) {
      try {
        await saveProject(next);
      } catch (cause) {
        // Keep the edit queued unless a newer version of the same project is already waiting.
        if (!queue.current.has(next.id)) queue.current.set(next.id, next);
        setSave({ kind: "error", message: cause instanceof Error ? cause.message : "Unknown storage error." });
        timer.current = window.setTimeout(() => void flush(), RETRY_DELAY_MS);
        return;
      }
    }
    if (queue.current.size === 0 && generationAtFlush === editGeneration.current) {
      setSave({ kind: "saved", at: Date.now() });
    } else {
      setSave({ kind: "saving" });
    }
  }, []);

  useEffect(() => {
    if (!project || project === loadedRef.current) return;
    queue.current.set(project.id, project);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
  }, [project, flush]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (queue.current.size || save.kind === "saving") event.preventDefault();
    };
    const hide = () => void flush();
    window.addEventListener("beforeunload", warn);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("pagehide", hide);
    };
  }, [flush, save.kind]);

  /** Shows a project that is already saved, without writing it again. */
  const load = useCallback((next: MoriProject) => {
    loadedRef.current = next;
    setProject(next);
    setSave({ kind: "idle" });
  }, []);

  /** Closes the open project, for example after it was deleted. */
  const unload = useCallback(() => {
    loadedRef.current = null;
    setProject(null);
    setSave({ kind: "idle" });
  }, []);

  /** Drops any queued write for a project that is being deleted, so autosave can't bring it back. */
  const forget = useCallback((id: string) => {
    queue.current.delete(id);
  }, []);

  const actions = useMemo<MoriActions>(() => {
    const change = (update: (current: MoriProject) => MoriProject) => {
      editGeneration.current += 1;
      setSave({ kind: "saving" });
      setProject(current => current && { ...update(current), lastModified: new Date().toISOString() });
    };
    return {
      updateProject: change,
      updateRow: (id, update) => change(p => ({ ...p, rows: p.rows.map(row => row.id === id ? update(row) : row) })),
      renameProject: name => change(p => ({ ...p, name })),
      setContext: (field, text) => change(p => ({ ...p, context: { ...p.context, [field]: text } })),
      addCharacter: fields => {
        const base = slugId(fields?.name ?? "");
        const id = `${base}_${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
        change(p => ({ ...p, characters: [...p.characters, {
          id, name: "New character", role: "", tone: "", description: "", ...fields,
        }] }));
        return id;
      },
      updateCharacter: (id, patch) => change(p => ({
        ...p, characters: p.characters.map(c => c.id === id ? { ...c, ...patch } : c),
      })),
      removeCharacter: id => change(p => ({
        ...p,
        characters: p.characters.filter(c => c.id !== id),
        rows: p.rows.map(row => row.characterId === id ? withSpeaker(row, undefined) : row),
      })),
      addGlossary: fields => {
        const id = crypto.randomUUID();
        change(p => ({ ...p, glossary: [{ id, en: "", jp: "", explanation: "", ...fields }, ...p.glossary] }));
        return id;
      },
      updateGlossary: (id, patch) => change(p => ({
        ...p, glossary: p.glossary.map(term => term.id === id ? { ...term, ...patch } : term),
      })),
      removeGlossary: id => change(p => ({ ...p, glossary: p.glossary.filter(term => term.id !== id) })),
    };
  }, []);

  return { project, save, actions, load, unload, forget };
}
