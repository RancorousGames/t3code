import type { MoriProject, MoriRow } from "./model.ts";

/**
 * Small, synchronous crash journal. Native/IndexedDB remains authoritative once
 * autosave succeeds; this preserves the latest edits during the autosave gap.
 */
interface Journal {
  modifiedAt: string;
  rows: Record<string, MoriRow>;
  removed: string[];
  fields: Partial<MoriProject>;
}
const key = (id: string) => `mori.pending-edits.v1.${id}`;

function read(id: string): Journal | null {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key(id)) ?? "null");
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const entry = data as Journal;
    return typeof entry.modifiedAt === "string" && entry.rows && entry.fields && Array.isArray(entry.removed) ? entry : null;
  } catch { return null; }
}

export function recordPendingEdit(before: MoriProject, next: MoriProject, rowId?: string): void {
  const prior = read(next.id);
  const rows = { ...(prior?.rows ?? {}) };
  const removed = new Set(prior?.removed ?? []);
  if (rowId) {
    const row = next.rows.find(row => row.id === rowId);
    if (row) { rows[row.id] = row; removed.delete(row.id); }
  } else if (before.rows !== next.rows) {
    const previous = new Map(before.rows.map(row => [row.id, row]));
    const updated = new Set(next.rows.map(row => row.id));
    for (const row of next.rows) {
      if (previous.get(row.id) !== row) { rows[row.id] = row; removed.delete(row.id); }
    }
    for (const row of before.rows) if (!updated.has(row.id)) { delete rows[row.id]; removed.add(row.id); }
  }
  const fields = { ...(prior?.fields ?? {}) };
  for (const field of ["name", "context", "characters", "glossary", "sourceFiles", "sources", "originals", "googleSync"] as const) {
    if (before[field] !== next[field]) Object.assign(fields, { [field]: next[field] });
  }
  const journal: Journal = { modifiedAt: next.lastModified, rows, removed: [...removed], fields };
  try {
    localStorage.setItem(key(next.id), JSON.stringify(journal));
  } catch {
    // Large imported originals can exceed localStorage's quota. Retain the
    // highest-value text edits; regular autosave still handles complete data.
    try { localStorage.setItem(key(next.id), JSON.stringify({ ...journal, fields: { name: next.name, context: next.context }, removed: [] })); }
    catch { /* Native autosave and earlier recovery snapshots remain available. */ }
  }
}

/** Apply only a journal newer than the saved file, without discarding untouched rows. */
export function recoverPendingEdits(saved: MoriProject): MoriProject | null {
  const journal = read(saved.id);
  if (!journal) return null;
  if (journal.modifiedAt < saved.lastModified) {
    clearPendingEdits(saved.id);
    return null;
  }
  const known = new Set(saved.rows.map(row => row.id));
  const removed = new Set(journal.removed);
  const rows = saved.rows.filter(row => !removed.has(row.id)).map(row => journal.rows[row.id] ?? row);
  rows.push(...Object.values(journal.rows).filter(row => !known.has(row.id) && !removed.has(row.id)));
  return { ...saved, ...journal.fields, rows, lastModified: journal.modifiedAt };
}

export function clearPendingEdits(id: string, savedModifiedAt?: string) {
  const journal = read(id);
  if (!savedModifiedAt || (journal && journal.modifiedAt <= savedModifiedAt)) localStorage.removeItem(key(id));
}
