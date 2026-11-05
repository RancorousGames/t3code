import { canDraft } from "./ai-batch.ts";
import type { MoriProject, MoriRow } from "./model.ts";

export type MatrixBatchSettings = {
  size: number;
  start: "selected" | "first";
  scope: "file" | "project";
  sessionId: string | null;
};
export type MatrixBatchPlan = {
  id: string;
  projectId: string;
  sessionId: string;
  ids: string[];
  cursor: number;
  skipped: number;
  stage: "running" | "paused" | "done" | "stopped";
  error?: string | undefined;
};

export const MATRIX_BATCH_EVENT = "mori:matrix-batch-changed";
export const MATRIX_BATCH_ACTIVATE = "mori:matrix-batch-activate";
const settingsKey = (id: string) => `mori.matrix.batch.settings:${id}`;
const planKey = (id: string) => `mori.matrix.batch.plan:${id}`;
const MAX_CUSTOM = 100_000;
export const DEFAULT_MATRIX_BATCH: MatrixBatchSettings = {
  size: 5, start: "selected", scope: "project", sessionId: null,
};

export function readMatrixBatchSettings(projectId: string): MatrixBatchSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(settingsKey(projectId)) ?? "null") as Partial<MatrixBatchSettings> | null;
    if (!raw) return { ...DEFAULT_MATRIX_BATCH };
    return {
      size: Number.isInteger(raw.size) && raw.size! > 0 && raw.size! <= MAX_CUSTOM ? raw.size! : 5,
      start: raw.start === "first" ? "first" : "selected",
      scope: raw.scope === "file" ? "file" : "project",
      sessionId: typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null,
    };
  } catch { return { ...DEFAULT_MATRIX_BATCH }; }
}

export function saveMatrixBatchSettings(projectId: string, settings: MatrixBatchSettings) {
  localStorage.setItem(settingsKey(projectId), JSON.stringify(settings));
}

/** Select from the actual Matrix display order, without wrapping to the top.
 * A batch of 5 covers the selected row plus the next FOUR displayed rows;
 * ineligible rows are skipped, not replaced by distant rows elsewhere. */
export function eligibleMatrixRows(
  project: MoriProject, settings: MatrixBatchSettings, selectedId: string | null,
  file: string | null, displayedRows: readonly MoriRow[] = project.rows,
): MoriRow[] {
  if (settings.scope === "file" && !file) return [];
  const rows = settings.scope === "file" ? displayedRows.filter(row => row.sourceFile === file) : displayedRows;
  const eligible = (row: MoriRow) => canDraft(row) && !row.ai?.trim();
  const index = settings.start === "selected" && selectedId
    ? rows.findIndex(row => row.id === selectedId)
    : rows.findIndex(eligible);
  if (index < 0) return [];
  // No wrap, and never borrow candidates from beyond this contiguous window.
  return rows.slice(index, index + settings.size).filter(eligible);
}

export function readMatrixBatchPlan(projectId: string): MatrixBatchPlan | null {
  try {
    const raw = JSON.parse(localStorage.getItem(planKey(projectId)) ?? "null") as MatrixBatchPlan | null;
    if (!raw || raw.projectId !== projectId || !raw.id || !raw.sessionId ||
      !Array.isArray(raw.ids) || !Number.isInteger(raw.cursor) || raw.cursor < 0 ||
      raw.cursor > raw.ids.length || !["running", "paused", "done", "stopped"].includes(raw.stage)) return null;
    return raw;
  } catch { return null; }
}

export function saveMatrixBatchPlan(plan: MatrixBatchPlan) {
  localStorage.setItem(planKey(plan.projectId), JSON.stringify(plan));
  window.dispatchEvent(new CustomEvent(MATRIX_BATCH_EVENT, { detail: plan.projectId }));
}

export function activateMatrixBatch(sessionId: string) {
  window.dispatchEvent(new CustomEvent(MATRIX_BATCH_ACTIVATE, { detail: sessionId }));
}

export function newMatrixBatchPlan(project: MoriProject, settings: MatrixBatchSettings, selectedId: string | null, file: string | null, displayedRows: readonly MoriRow[] = project.rows): MatrixBatchPlan | null {
  const ids = eligibleMatrixRows(project, settings, selectedId, file, displayedRows).map(row => row.id);
  if (!ids.length || !settings.sessionId) return null;
  return {
    id: crypto.randomUUID(), projectId: project.id, sessionId: settings.sessionId,
    ids, cursor: 0, skipped: 0, stage: "running",
  };
}
