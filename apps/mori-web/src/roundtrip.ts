import {
  DOCX_PARAGRAPH, DOCX_TEXT, columnIndex, columnLetter, delimiterOf, fromBase64, jsEscape, parseCsv, parsePo, poEscape,
  scanAssignments, workbookSheets, type RowLoc,
} from "./importers.ts";
import type { SourceRecord } from "./importPlan.ts";
import type { MoriProject, MoriRow } from "./model.ts";
import { chooseText, type TranslationMode } from "./exporters.ts";
import { replaceInZip, unzip, zipFiles } from "./zip.ts";

/**
 * Export back to the original formats: the translations are written into a copy of each imported file,
 * which is otherwise unchanged. Tabular files get the text in the mapped translation column (or a new
 * "Japanese" column); JSON, PO, scripts, text and Word files get it in place of the English.
 * Lines without output text keep what the file already had.
 */

const NEW_COLUMN = "Japanese";
type Write = { loc: RowLoc; text: string };
type Edit = { record: SourceRecord; writes: Write[] };

const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

/** Grid column for the translation of one tab, and whether it's a new column that needs a header. */
const targetOf = (record: SourceRecord, width: number) =>
  record.targetCol !== undefined ? { col: record.targetCol, isNew: false } : { col: (record.lastCol ?? width - 1) + 1, isNew: true };

function writeCsv(text: string, edits: Edit[]): string {
  const delimiter = delimiterOf(text.replace(/^﻿/, ""));
  const grid = parseCsv(text, delimiter);
  const width = Math.max(0, ...grid.map(row => row.length));
  for (const { record, writes } of edits) {
    const { col, isNew } = targetOf(record, width);
    const put = (r: number, value: string) => {
      while (grid.length <= r) grid.push([]);
      const row = grid[r]!;
      while (row.length <= col) row.push("");
      row[col] = value;
    };
    if (isNew) put(record.headerRow ?? 0, NEW_COLUMN);
    for (const { loc, text: value } of writes) if (loc.r !== undefined) put(loc.r, value);
  }
  const quote = (cell: string) => (/[",\t\r\n]/.test(cell) || cell !== cell.trim() ? `"${cell.replace(/"/g, '""')}"` : cell);
  const eol = eolOf(text);
  return (text.startsWith("﻿") ? "﻿" : "") + grid.map(row => row.map(quote).join(delimiter)).join(eol) + (/\r?\n$/.test(text) ? eol : "");
}

function writeJson(text: string, edits: Edit[]): string {
  const data: unknown = JSON.parse(text.replace(/^﻿/, ""));
  for (const { record, writes } of edits) {
    for (const { loc, text: value } of writes) {
      if (loc.path?.length) {
        let node = data as Record<string | number, unknown> | undefined;
        for (const key of loc.path.slice(0, -1)) node = node?.[key] as Record<string | number, unknown> | undefined;
        const last = loc.path.at(-1)!;
        if (node && typeof node[last] === "string") node[last] = value;
      } else if (loc.r !== undefined && Array.isArray(data) && data[loc.r]) {
        data[loc.r][record.targetKey ?? "ja"] = value;
      }
    }
  }
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? 2;
  return JSON.stringify(data, null, indent) + (text.endsWith("\n") ? "\n" : "");
}

function writePo(text: string, writes: Write[]): string {
  const lines = text.split(/\r?\n/);
  const entries = parsePo(text);
  const edits = writes.flatMap(w => (w.loc.entry !== undefined && entries[w.loc.entry] ? [{ entry: entries[w.loc.entry]!, text: w.text }] : []))
    .sort((a, b) => b.entry.strStart - a.entry.strStart);
  for (const { entry, text: value } of edits) {
    const prefix = /^\s*msgstr(\[0\])?/.exec(lines[entry.strStart]!)?.[0] ?? "msgstr";
    lines.splice(entry.strStart, entry.strEnd - entry.strStart + 1, `${prefix} "${poEscape(value)}"`);
  }
  return lines.join(eolOf(text));
}

/** Replaces value spans inside lines. Script values are escaped for their own quote character. */
function writeLines(text: string, writes: Write[], script: boolean): string {
  const lines = text.split(/\r?\n/);
  const quotes = script ? new Map(scanAssignments(text).map(a => [a.line, a.quote])) : null;
  const edits = writes.filter(w => w.loc.line !== undefined)
    .sort((a, b) => a.loc.line! - b.loc.line! || b.loc.start! - a.loc.start!);
  for (const { loc, text: value } of edits) {
    const line = lines[loc.line!];
    if (line === undefined) continue;
    const escaped = quotes ? jsEscape(value, quotes.get(loc.line!) ?? '"') : value.replace(/\r?\n/g, " ");
    lines[loc.line!] = line.slice(0, loc.start) + escaped + line.slice(loc.end);
  }
  return lines.join(eolOf(text));
}

const xmlEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Each translated paragraph's text goes into its first run and the other runs are emptied, so the paragraph keeps its style. */
async function writeDocx(bytes: Uint8Array, writes: Write[]): Promise<Uint8Array> {
  const xml = new TextDecoder().decode((await unzip(bytes.slice().buffer)).get("word/document.xml"));
  const byParagraph = new Map(writes.flatMap(w => (w.loc.p !== undefined ? [[w.loc.p, w.text] as const] : [])));
  let p = -1;
  const out = xml.replace(DOCX_PARAGRAPH, (full, inner: string) => {
    if (![...inner.matchAll(DOCX_TEXT)].map(t => t[1]).join("").trim()) return full;
    const value = byParagraph.get(++p);
    if (value === undefined) return full;
    let first = true;
    const replaced = inner.replace(DOCX_TEXT, run => {
      const open = /^<w:t(?:\s[^>]*)?>/.exec(run)?.[0] ?? "<w:t>";
      const body = first ? xmlEscape(value) : "";
      first = false;
      return `${open.includes("xml:space") ? open : open.replace("<w:t", '<w:t xml:space="preserve"')}${body}</w:t>`;
    });
    return full.replace(inner, replaced);
  });
  return replaceInZip(bytes, new Map([["word/document.xml", new TextEncoder().encode(out)]]));
}

/** Writes cells straight into the sheet XML, so styles, formulas and other tabs stay exactly as they were. */
async function writeXlsx(bytes: Uint8Array, edits: Edit[]): Promise<Uint8Array> {
  const files = await unzip(bytes.slice().buffer);
  const sheets = workbookSheets(files);
  const replacements = new Map<string, Uint8Array>();
  for (const { record, writes } of edits) {
    const sheetPath = sheets.find(s => s.name === record.sheet)?.path ?? sheets[0]?.path;
    const source = sheetPath && (replacements.get(sheetPath) ?? files.get(sheetPath));
    if (!sheetPath || !source) continue;
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(source), "application/xml");
    const ns = doc.documentElement.namespaceURI;
    const sheetData = doc.getElementsByTagName("sheetData")[0];
    if (!sheetData) continue;
    const rowsByNumber = new Map([...sheetData.getElementsByTagName("row")].map(row => [Number(row.getAttribute("r")), row]));
    const width = Math.max(0, ...[...sheetData.getElementsByTagName("c")].map(c => columnIndex(c.getAttribute("r") ?? "A") + 1));
    const { col, isNew } = targetOf(record, width);

    const put = (r: number, value: string) => {
      const number = r + 1;
      let row = rowsByNumber.get(number);
      if (!row) {
        row = doc.createElementNS(ns, "row");
        row.setAttribute("r", String(number));
        const after = [...rowsByNumber.keys()].filter(n => n > number).sort((a, b) => a - b)[0];
        sheetData.insertBefore(row, after ? rowsByNumber.get(after)! : null);
        rowsByNumber.set(number, row);
      }
      const ref = `${columnLetter(col)}${number}`;
      const cells = [...row.getElementsByTagName("c")];
      let cell = cells.find(c => c.getAttribute("r") === ref);
      if (!cell) {
        cell = doc.createElementNS(ns, "c");
        cell.setAttribute("r", ref);
        row.insertBefore(cell, cells.find(c => columnIndex(c.getAttribute("r") ?? "A") > col) ?? null);
      }
      while (cell.firstChild) cell.removeChild(cell.firstChild);
      cell.setAttribute("t", "inlineStr");
      const is = doc.createElementNS(ns, "is");
      const t = doc.createElementNS(ns, "t");
      t.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      t.textContent = value;
      is.appendChild(t);
      cell.appendChild(is);
    };
    if (isNew) put(record.headerRow ?? 0, NEW_COLUMN);
    for (const { loc, text } of writes) if (loc.r !== undefined) put(loc.r, text);
    replacements.set(sheetPath, new TextEncoder().encode(new XMLSerializer().serializeToString(doc)));
  }
  return replaceInZip(bytes, replacements);
}

export interface OriginalExport {
  files: { path: string; data: Uint8Array }[];
  /** Lines whose text went into a file. */
  written: number;
  /** Lines of exportable files that had no output text, so the file keeps its own content there. */
  untranslated: number;
}

/** Projects imported before original files were kept (or from Google Drive) have nothing to rebuild. */
export const canExportOriginals = (project: MoriProject) => !!project.sources?.length && !!project.originals;

export async function buildOriginalExport(project: MoriProject, mode: TranslationMode = "curated"): Promise<OriginalExport> {
  const records = project.sources ?? [];
  const originals = project.originals ?? {};
  const rowsByFile = new Map<string, MoriRow[]>();
  for (const row of project.rows) {
    if (row.sourceFile && row.loc) rowsByFile.set(row.sourceFile, [...(rowsByFile.get(row.sourceFile) ?? []), row]);
  }
  const files: OriginalExport["files"] = [];
  let written = 0;
  let untranslated = 0;

  for (const path of [...new Set(records.map(r => r.path))]) {
    const original = originals[path];
    if (original === undefined) continue;
    const fileRecords = records.filter(r => r.path === path);
    const kind = fileRecords[0]!.kind;
    const rows = rowsByFile.get(path) ?? [];
    const edits: Edit[] = fileRecords.map(record => ({
      record,
      writes: rows.flatMap(row => {
        if ((row.loc!.sheet ?? undefined) !== record.sheet) return [];
        const text = chooseText(row, mode);
        if (!text) {
          untranslated++;
          return [];
        }
        written++;
        return [{ loc: row.loc!, text }];
      }),
    }));
    const writes = edits.flatMap(e => e.writes);
    const encode = (text: string) => new TextEncoder().encode(text);
    const data = kind === "xlsx" ? await writeXlsx(fromBase64(original), edits)
      : kind === "docx" ? await writeDocx(fromBase64(original), writes)
      : kind === "csv" || kind === "sheet" ? encode(writeCsv(original, edits))
      : kind === "json" ? encode(writeJson(original, edits))
      : kind === "po" ? encode(writePo(original, writes))
      : encode(writeLines(original, writes, kind === "js"));
    // Google sources have no file extension of their own.
    const extension = kind === "sheet" ? "csv" : kind === "xlsx" || kind === "docx" ? kind : "";
    const name = path.replace(/[…]/g, "");
    files.push({ path: extension && !name.toLowerCase().endsWith(`.${extension}`) ? `${name}.${extension}` : name, data });
  }
  return { files, written, untranslated };
}

/** One file downloads as itself; several download as one zip that keeps their folders. */
export function downloadOriginalExport(project: MoriProject, result: OriginalExport) {
  const single = result.files.length === 1 ? result.files[0]! : null;
  const data = single ? single.data : zipFiles(result.files);
  const filename = single ? single.path.split("/").pop()! : `${project.name.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 80) || "translation"}-ja.zip`;
  const url = URL.createObjectURL(new Blob([data.slice()], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return filename;
}
