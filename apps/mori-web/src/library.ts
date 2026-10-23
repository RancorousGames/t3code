import { parseMoriProject, type MoriProject } from "./model.ts";
import { statusOf } from "./insights.ts";
import { nativeMori } from "./backend.ts";

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

const DEMO_KEY = "mori.demo-seeded.v1";
export const hasSeededDemo = () => localStorage.getItem(DEMO_KEY) === "1";
export const markSeededDemo = () => localStorage.setItem(DEMO_KEY, "1");

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
  const backend = nativeMori();
  if (!backend) return Promise.resolve();
  if (initialized) return initialized;
  initialized = (async () => {
    let found = await backend.listProjects();
    if (found.problems.length) {
      throw new Error(
        `Native project files need recovery: ${found.problems.map(p => p.reason).join("; ")}`,
      );
    }
    // Only import old browser data when native storage is empty. This prevents
    // an orphaned IndexedDB project from resurrecting a deleted native project.
    if (!found.entries.length) {
      const legacy = readIndex();
      for (const item of legacy) {
        const old = await withStore("readonly", store => store.get(item.id));
        if (old !== undefined) await backend.saveProject(parseMoriProject(old));
      }
      found = await backend.listProjects();
      if (found.problems.length) throw new Error("Native project migration requires recovery.");
    }
    writeIndex(found.entries);
  })().catch(error => {
    initialized = null;
    throw error;
  });
  return initialized;
}

/** Writes project data first, then updates the cached library index. */
export async function saveProject(project: MoriProject): Promise<void> {
  const native = nativeMori();
  if (native) {
    await initializeLibrary();
    await native.saveProject(project);
  } else {
    await withStore("readwrite", store => store.put(project));
  }
  const others = readIndex().filter(entry => entry.id !== project.id);
  writeIndex([entryOf(project), ...others]);
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
}

export async function listProjectRevisions(id: string) {
  const native = nativeMori();
  return native ? native.listRevisions(id) : [];
}

export async function restoreProjectRevision(id: string, revisionId: string): Promise<MoriProject> {
  const native = nativeMori();
  if (!native) throw new Error("Native revision recovery requires the desktop app.");
  const recovered = parseMoriProject(await native.restoreRevision(id, revisionId));
  writeIndex([entryOf(recovered), ...readIndex().filter(entry => entry.id !== id)]);
  return recovered;
}
