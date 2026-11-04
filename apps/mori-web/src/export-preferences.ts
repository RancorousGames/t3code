import type { ExportFormat, TranslationMode } from "./exporters.ts";

export interface ExportPreferences {
  format: ExportFormat;
  mode: TranslationMode;
  lastTable?: Partial<Record<ExportFormat, string>>;
  lastOriginal?: string;
}
const key = (id: string) => `mori.export.v1.${id}`;
const DEFAULTS: ExportPreferences = { format: "csv", mode: "curated" };

export function readExportPreferences(id: string): ExportPreferences {
  try {
    const data = JSON.parse(localStorage.getItem(key(id)) ?? "null") as Partial<ExportPreferences> | null;
    if (!data || typeof data !== "object") return DEFAULTS;
    return {
      format: data.format === "json" || data.format === "po" ? data.format : "csv",
      mode: data.mode === "curated-or-draft" ? data.mode : "curated",
      ...(data.lastTable && typeof data.lastTable === "object" ? { lastTable: data.lastTable } : {}),
      ...(typeof data.lastOriginal === "string" ? { lastOriginal: data.lastOriginal } : {}),
    };
  } catch { return DEFAULTS; }
}
export function writeExportPreferences(id: string, patch: Partial<ExportPreferences>) {
  localStorage.setItem(key(id), JSON.stringify({ ...readExportPreferences(id), ...patch }));
}
