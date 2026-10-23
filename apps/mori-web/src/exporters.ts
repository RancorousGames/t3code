import type { MoriProject, MoriRow } from "./model.ts";
import { checkRow } from "./insights.ts";

/**
 * Normalized interchange exports. These do NOT reconstruct original DOCX,
 * XLSX, scripts or nested JSON: the imported source structure isn't yet
 * retained faithfully enough for that. Never label these as a round-trip.
 */
export type ExportFormat = "csv" | "json" | "po";
export type TranslationMode = "curated" | "curated-or-draft";

const chooseText = (row: MoriRow, mode: TranslationMode) =>
  row.final || (mode === "curated-or-draft" ? row.ai || row.legacy || "" : "");

const csvQuote = (value: string) => `"${value.replace(/"/g, '""')}"`;
const poQuote = (value: string) => JSON.stringify(value).replace(/\\u2028/g, "\\u2028").replace(/\\u2029/g, "\\u2029");
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "translation";

export interface ExportReport {
  format: ExportFormat;
  filename: string;
  data: string;
  total: number;
  filled: number;
  empty: number;
  warnings: { id: string; reasons: string[] }[];
  mode: TranslationMode;
}

export function buildInterchangeExport(project: MoriProject, format: ExportFormat, mode: TranslationMode = "curated"): ExportReport {
  const rows = project.rows.map(row => ({
    id: row.id,
    source: row.source,
    translation: chooseText(row, mode),
    speaker: project.characters.find(c => c.id === row.characterId)?.name ?? "",
    sourceFile: row.sourceFile ?? "",
    status: row.status,
  }));

  const data = format === "csv"
    // Excel recognizes UTF-8 CSV with a BOM and CRLF rows. Every cell is quoted
    // to preserve Japanese, embedded line breaks, delimiters and IDs.
    ? "\ufeff" + [
        ["id", "source", "translation", "speaker", "sourceFile", "status"].map(csvQuote).join(","),
        ...rows.map(row => [row.id, row.source, row.translation, row.speaker, row.sourceFile, row.status].map(csvQuote).join(",")),
      ].join("\r\n") + "\r\n"
    : format === "json"
      ? JSON.stringify({ project: project.name, language: "ja", strings: rows }, null, 2) + "\n"
      : rows.map(row => [
        row.sourceFile ? `#. Source file: ${row.sourceFile.replace(/[\r\n]/g, " ")}` : "",
        `msgctxt ${poQuote(row.id)}`,
        `msgid ${poQuote(row.source)}`,
        `msgstr ${poQuote(row.translation)}`,
      ].filter(Boolean).join("\n")).join("\n\n") + "\n";

  return {
    format,
    filename: `${safeName(project.name)}-ja.${format}`,
    data,
    total: rows.length,
    filled: rows.filter(r => r.translation.trim()).length,
    empty: rows.filter(r => !r.translation.trim()).length,
    warnings: project.rows.flatMap(row => {
      const reasons = checkRow(row, project.glossary).map(w => w.message);
      return reasons.length ? [{ id: row.id, reasons }] : [];
    }),
    mode,
  };
}

export function browserDownload(report: ExportReport) {
  const url = URL.createObjectURL(new Blob([report.data], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = report.filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
