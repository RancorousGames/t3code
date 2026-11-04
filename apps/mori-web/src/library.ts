import { parseMoriProject, type MoriProject } from "./model.ts";
import { statusOf } from "./insights.ts";
import { nativeMori } from "./backend.ts";
import bundledUiCatalog from "../localization/MonkuNoMoriUI.mori?raw";
import { isLegacyDemo, mergeUiCatalog } from "./startup-projects.ts";
import { MORI_UI_PROJECT_ID } from "./ui-project-id.ts";
import { clearPendingEdits } from "./recovery-journal.ts";

// In the packaged Windows app, native project files under Monku's *separate*
// user-data directory are authoritative. IndexedDB is the web-preview fallback
// and the one-time migration source for earlier Mori preview versions.

export interface LibraryEntry {
  id: string;
  name: string;
  lines: number;
  translated: number;
  lastModified: string;
}

const DB_NAME = "mori-library";
const STORE = "projects";
const INDEX_KEY = "mori.library.v1";
const ACTIVE_KEY = "mori.active-project.v1";

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
  });

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not write to the project store."));
      transaction.onabort = () => reject(transaction.error ?? new Error("The project store write was cancelled."));
    });
  } finally {
    db.close();
  }
}

export const entryOf = (project: MoriProject): LibraryEntry => ({
  id: project.id,
  name: project.name,
  lines: project.rows.length,
  translated: project.rows.filter(row => statusOf(row) === "translated").length,
  lastModified: project.lastModified,
});

export function readIndex(): LibraryEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed as LibraryEntry[] : [];
  } catch {
    return [];
  }
}

const writeIndex = (entries: LibraryEntry[]) => localStorage.setItem(INDEX_KEY, JSON.stringify(entries));

const DEMO_MIGRATION_KEY = "mori.default-demo-removed.v1";

export const readActiveId = (): string | null => localStorage.getItem(ACTIVE_KEY);
export const writeActiveId = (id: string) => localStorage.setItem(ACTIVE_KEY, id);
export const clearActiveId = () => localStorage.removeItem(ACTIVE_KEY);

let initialized: Promise<void> | null = null;

/**
 * Hydrate the sync library index from native storage before initial project
 * selection. Migrates older browser-only projects once, without deleting the
 * original IndexedDB copies. Repeated calls share one initialization promise.
 */
export function initializeLibrary(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    const backend = nativeMori();
    if (backend) {
      let found = await backend.listProjects();
      if (found.problems.length) {
        throw new Error(`Native project files need recovery: ${found.problems.map(p => p.reason).join("; ")}`);
      }
      // Migrate earlier browser-only libraries, but never resurrect projects
      // deleted from a nonempty native library.
      if (!found.entries.length) {
        for (const item of readIndex()) {
          const old = await withStore("readonly", store => store.get(item.id));
          if (old !== undefined) await backend.saveProject(parseMoriProject(old));
        }
        found = await backend.listProjects();
        if (found.problems.length) throw new Error("Native project migration requires recovery.");
      }
      writeIndex(found.entries);
    }

    const readStored = async (id: string): Promise<MoriProject | null> => {
      const raw = backend ? await backend.loadProject(id) : await withStore("readonly", store => store.get(id));
      return raw == null ? null : parseMoriProject(raw);
    };
    const putStored = async (project: MoriProject) => {
      if (backend) await backend.saveProject(project);
      else await withStore("readwrite", store => store.put(project));
    };
    const deleteStored = async (id: string) => {
      if (backend) await backend.deleteProject(id);
      else await withStore("readwrite", store => store.delete(id));
    };

    // Upgrades from the old auto-demo install should open without a project.
    // Mark the migration so explicitly reimported samples are not removed later.
    if (localStorage.getItem(DEMO_MIGRATION_KEY) !== "1") {
      for (const id of ["mori_sample_hollowmere", "mori_skeleton_demo"]) {
        const stored = await readStored(id);
        if (!stored || !isLegacyDemo(stored)) continue;
        await deleteStored(id);
        writeIndex(readIndex().filter(entry => entry.id !== id));
        if (readActiveId() === id) clearActiveId();
      }
      localStorage.setItem(DEMO_MIGRATION_KEY, "1");
    }

    // The UI catalog ships in the renderer bundle, so cloning/updating the
    // repository never requires a developer-only bootstrap script or paths.
    const catalog = parseMoriProject(JSON.parse(bundledUiCatalog));
    if (catalog.id !== MORI_UI_PROJECT_ID) throw new Error("Invalid bundled Mori UI catalog.");
    const saved = await readStored(catalog.id);
    const merged = mergeUiCatalog(catalog, saved);
    if (merged !== saved) await putStored(merged);

    if (backend) {
      const found = await backend.listProjects();
      if (found.problems.length) throw new Error("Native project library requires recovery.");
      writeIndex(found.entries);
    } else {
      writeIndex([entryOf(merged), ...readIndex().filter(entry => entry.id !== merged.id)]);
    }
  })().catch(error => {
    initialized = null;
    throw error;
  });
  return initialized;
}

/** Writes project data first, then updates the cached library index. */
export async function saveProject(project: MoriProject): Promise<void> {
  const native = nativeMori();
  let next = project;
  if (native) {
    await initializeLibrary();
    if (project.id === "mori_self_ui_ja") {
      // A source-catalog bootstrap can add UI rows while the translation editor
      // still has the older project open. Its next autosave must not erase those
      // new keys or newly seeded translations.
      const current = await native.loadProject(project.id);
      if (current) {
        const catalog = parseMoriProject(current);
        const outdated = project.rows.length < catalog.rows.length;
        if (outdated) {
          const saved = new Map(catalog.rows.map(row => [row.id, row]));
          const incoming = new Set(project.rows.map(row => row.id));
          const merged = project.rows.filter(row =>
            !/(?:EN\s*(?:→|->)\s*JA|English\s*(?:→|->)\s*Japanese)/i.test(row.source)).map(row => {
            const latest = saved.get(row.id);
            return latest?.final?.trim() && !row.final.trim() && !row.ai?.trim()
              ? { ...row, final: latest.final, status: "translated" as const } : row;
          });
          merged.push(...catalog.rows.filter(row => !incoming.has(row.id)));
          next = { ...project, rows: merged };
        }
      }
      next = { ...next, name: next.name.replace(/\s*\(EN\s*(?:→|->)\s*JA\)\s*$/, "") };
    }
    await native.saveProject(next);
  } else {
    await withStore("readwrite", store => store.put(next));
  }
  const others = readIndex().filter(entry => entry.id !== next.id);
  writeIndex([entryOf(next), ...others]);
}

export async function loadProject(id: string): Promise<MoriProject | null> {
  const native = nativeMori();
  if (native) {
    await initializeLibrary();
    const stored = await native.loadProject(id);
    return stored === null ? null : parseMoriProject(stored);
  }
  const stored = await withStore("readonly", store => store.get(id));
  return stored === undefined ? null : parseMoriProject(stored);
}

export async function removeProject(id: string): Promise<void> {
  const native = nativeMori();
  if (native) {
    await initializeLibrary();
    await native.deleteProject(id);
  } else {
    await withStore("readwrite", store => store.delete(id));
  }
  writeIndex(readIndex().filter(entry => entry.id !== id));
  clearPendingEdits(id);
}

export async function listProjectRevisions(id: string) {
  const native = nativeMori();
  return native ? native.listRevisions(id) : [];
}

export async function restoreProjectRevision(id: string, revisionId: string): Promise<MoriProject> {
  const native = nativeMori();
  if (!native) throw new Error("Native revision recovery requires the desktop app.");
  const recovered = parseMoriProject(await native.restoreRevision(id, revisionId));
  clearPendingEdits(id);
  writeIndex([entryOf(recovered), ...readIndex().filter(entry => entry.id !== id)]);
  return recovered;
}
