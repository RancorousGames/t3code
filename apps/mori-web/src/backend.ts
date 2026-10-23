import type { MoriProject } from "./model.ts";

// Matches the capabilities exposed by the independent Mori Electron preload.
// In a normal web preview this is absent and IndexedDB remains the storage.
export interface NativeLibraryEntry {
  id: string;
  name: string;
  lines: number;
  translated: number;
  lastModified: string;
}
export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
}
export interface MoriBackend {
  readonly version: number;
  codexTranslationConfig(): Promise<{provider: string; model: string; reasoningEffort: string; available: boolean}>;
  codexTranslate(request: {mode: "single" | "batch"; ids: string[]; prompt: string}): Promise<{text: string; model: string; reasoningEffort: string; ids: string[]; mode: "single" | "batch"}>;
  listProjects(): Promise<{ entries: NativeLibraryEntry[]; problems: { filename: string; reason: string }[] }>;
  loadProject(id: string): Promise<unknown | null>;
  saveProject(project: MoriProject): Promise<{ id: string; bytes: number }>;
  deleteProject(id: string): Promise<{ id: string }>;
  listRevisions(id: string): Promise<{ id: string; at: number }[]>;
  restoreRevision(id: string, revisionId: string): Promise<unknown>;
  openProjectBackup(): Promise<{ project: unknown; filename: string } | null>;
  saveProjectBackup(project: MoriProject): Promise<{ filename: string } | null>;
  exportInterchange(request: { format: "json" | "csv" | "po"; filename: string; data: string }): Promise<{ filename: string } | null>;
  readPublicSheet(id: string, gid?: string): Promise<string>;
  googleStatus(): Promise<{ configured: boolean; connected: boolean; scopes: string[] }>;
  googleConfigure(): Promise<{ configured: boolean; connected: boolean } | null>;
  googleLogin(): Promise<{ connected: boolean }>;
  googleLogout(): Promise<{ connected: boolean }>;
  googleListFiles(page?: string): Promise<{ files: GoogleDriveFile[]; nextPageToken: string | null }>;
  googleCopy(id: string, name: string): Promise<{ id: string; name: string; mimeType: string }>;
  googleExport(id: string, kind: "sheet" | "doc"): Promise<{ data: string; extension: string }>;
  googleSheetInfo(id: string): Promise<{ id: string; title: string; sheets: { gid: number; title: string; rowCount: number }[] }>;
  googleReadValues(id: string, range: string): Promise<{ range: string; values: string[][] }>;
  googleSyncChecked(id: string, changes: { range: string; expected: string; next: string }[]): Promise<{ updatedCells: number; conflicts: { range: string; expected: string; actual: string }[] }>;
}
declare global {
  interface Window { readonly moriBackend?: MoriBackend; }
}
export const nativeMori = () => window.moriBackend;
