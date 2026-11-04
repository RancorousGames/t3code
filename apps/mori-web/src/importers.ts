import { unzip } from "./zip.ts";
import { nativeMori } from "./backend.ts";
import type { Mapping } from "./importPlan.ts";

export type SourceKind = "json" | "csv" | "txt" | "po" | "js" | "xlsx" | "docx" | "sheet";

/**
 * Where a line lives in its original file, so export can write the translation back in place.
 * Exactly one position applies per format: r (grid row of csv/xlsx/sheet, or array index of a JSON list),
 * path (nested JSON leaf), entry (PO entry), line/start/end (character span in a JS/TXT line), p (DOCX paragraph).
 */
export interface RowLoc {
  sheet?: string;
  r?: number;
  path?: (string | number)[];
  entry?: number;
  line?: number;
  start?: number;
  end?: number;
  p?: number;
}

/** A rectangular table of one source. Every row has one cell per header. */
export interface Table {
  headers: string[];
  rows: string[][];
  /** Original position of each row (parallel to rows). */
  locs: RowLoc[];
  /** Tabular sources: grid row of the header and the grid column behind each header. */
  headerRow?: number;
  colIndex?: number[];
  /** Full cell grid of tabular sources, so the header row can be moved. Not saved. */
  grid?: string[][];
  /** Structured formats (PO, JS, TXT, DOCX, nested JSON) know their own fields. */
  preset?: Mapping;
}

export interface StagedTable extends Table {
  /** Display name, e.g. "chapter1.json" or "Hollowmere UI · Menus". */
  name: string;
  /** Where the source lives, e.g. "dialogue/chapter1.json". Every line keeps this as its source file. */
  path: string;
  kind: SourceKind;
  /** Workbook tab name. */
  sheet?: string;
  /** The untouched file (text, or base64 for XLSX/DOCX), kept so export can rebuild it. */
  original?: string;
}

export const ACCEPTED_EXTENSIONS = ["json", "docx", "xlsx", "csv", "tsv", "po", "pot", "js", "ts", "txt"] as const;
const KIND_BY_EXTENSION: Record<string, SourceKind> = {
  json: "json", docx: "docx", xlsx: "xlsx", csv: "csv", tsv: "csv", po: "po", pot: "po", js: "js", ts: "js", txt: "txt",
};

export function kindOf(filename: string): SourceKind | null {
  return KIND_BY_EXTENSION[filename.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const hasLetters = (text: string) => /\p{L}/u.test(text);
export const hasJapanese = (text: string) => /[぀-ヿ㐀-䶿一-龯ｦ-ﾟ]/.test(text);

/** 0 → A, 25 → Z, 26 → AA */
export const columnLetter = (index: number) => {
  let result = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
  return result;
};

// ---------------------------------------------------------------- tabular

/** Tab-separated when the first line has more tabs than commas, else comma-separated. */
export const delimiterOf = (text: string) => {
  const first = text.slice(0, text.search(/\r?\n|$/));
  return (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? "\t" : ",";
};

/** RFC 4180 CSV: quoted cells may contain delimiters, quotes (doubled) and line breaks. */
export function parseCsv(text: string, delimiter = delimiterOf(stripBom(text))): string[][] {
  const source = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const HEADER_WORDS = /^(id|key|text ?id|string ?id|name|en|english|ja|jp|japanese|source|target|text|original|translation|speaker|character|actor|comment|comments|notes?|context|desc|description|type|category)\b/i;

/**
 * Picks the header among the first 10 rows: the row with the most short, non-numeric labels,
 * boosted by typical header words. Handles sheets with a title or blank rows above the header.
 */
export function detectHeaderRow(grid: string[][]): number {
  let best = 0;
  let bestScore = -1;
  grid.slice(0, 10).forEach((row, index) => {
    const filled = row.filter(cell => cell.trim());
    if (!filled.length) return;
    const labels = filled.filter(cell => cell.length < 60 && !/^[\d.,\s-]+$/.test(cell)).length;
    const words = filled.filter(cell => HEADER_WORDS.test(cell.trim())).length;
    if (labels + words * 3 > bestScore) {
      best = index;
      bestScore = labels + words * 3;
    }
  });
  return best;
}

/**
 * Turns a grid into a table below the given (or detected) header row. Blank rows and fully empty
 * columns are dropped; blank or repeated headers get the column letter so every column stays usable.
 */
export function tableFromRows(grid: string[][], headerRow = detectHeaderRow(grid)): Table {
  const width = Math.max(0, ...grid.map(row => row.length));
  const head = grid[headerRow] ?? [];
  const headers: string[] = [];
  const colIndex: number[] = [];
  for (let c = 0; c < width; c++) {
    if (!grid.some((row, r) => r >= headerRow && (row[c] ?? "").trim())) continue;
    let label = (head[c] ?? "").replace(/\s+/g, " ").trim() || `Column ${columnLetter(c)}`;
    if (headers.includes(label)) label = `${label} (${columnLetter(c)})`;
    headers.push(label);
    colIndex.push(c);
  }
  const rows: string[][] = [];
  const locs: RowLoc[] = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const cells = grid[r]!;
    if (!cells.some(cell => cell.trim())) continue;
    rows.push(colIndex.map(c => cells[c] ?? ""));
    locs.push({ r });
  }
  return { headers, rows, locs, headerRow, colIndex, grid };
}

// ---------------------------------------------------------------- json

const NOTE_KEYS = /^_?(context|comments?|notes?|description|desc)$/i;

/** String leaves with letters in them; a sibling "context"/"comment" string becomes their note. */
export function flattenJson(root: unknown) {
  const out: { path: (string | number)[]; text: string; note: string }[] = [];
  const walk = (node: unknown, path: (string | number)[]) => {
    if (typeof node === "string") {
      if (hasLetters(node)) out.push({ path, text: node, note: "" });
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const entries: [string | number, unknown][] = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
    const noteEntry = !Array.isArray(node) && entries.length > 1
      ? entries.find(([key, value]) => typeof value === "string" && NOTE_KEYS.test(String(key))) : undefined;
    const start = out.length;
    for (const [key, value] of entries) if (key !== noteEntry?.[0]) walk(value, [...path, key]);
    if (noteEntry) for (let i = start; i < out.length; i++) out[i]!.note ||= noteEntry[1] as string;
  };
  walk(root, []);
  return out;
}

const pathLabel = (path: (string | number)[]) =>
  path.map((key, i) => (typeof key === "number" ? `[${key}]` : i ? `.${key}` : key)).join("");

/** Arrays of flat objects keep their own columns. Anything else becomes key/text rows with dotted paths. */
export function parseJsonTable(text: string): Table {
  const data: unknown = JSON.parse(stripBom(text));
  if (Array.isArray(data) && data.length && data.every(isRecord)) {
    const headers = [...new Set(data.flatMap(item => Object.keys(item).filter(key => typeof item[key] !== "object" || item[key] === null)))];
    return {
      headers,
      rows: data.map(item => headers.map(header => (item[header] == null ? "" : String(item[header])))),
      locs: data.map((_, r) => ({ r })),
    };
  }
  const leaves = flattenJson(data);
  if (!leaves.length) throw new Error("No text was found in this JSON file.");
  return {
    headers: ["key", "text", "note"],
    rows: leaves.map(leaf => [pathLabel(leaf.path), leaf.text, leaf.note]),
    locs: leaves.map(leaf => ({ path: leaf.path })),
    preset: { id: "key", src: "text", tr: "", spk: "", note: "note" },
  };
}

// ---------------------------------------------------------------- po

const poUnescape = (value: string) => value.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c));
export const poEscape = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t");

export interface PoEntry {
  ctx?: string;
  id: string;
  str: string;
  notes: string[];
  /** First and last line of the msgstr (with continuation lines) in the original text. */
  strStart: number;
  strEnd: number;
}

/** gettext PO: msgctxt, multi-line strings and extracted comments. The header entry (empty msgid) is skipped. */
export function parsePo(text: string): PoEntry[] {
  const entries: PoEntry[] = [];
  let current: Partial<PoEntry> & { notes: string[] } = { notes: [] };
  let field: "ctx" | "id" | "str" | null = null;
  const finish = () => {
    if (current.id !== undefined && current.strStart !== undefined && current.id !== "") entries.push(current as PoEntry);
    current = { notes: [] };
    field = null;
  };
  const quoted = (line: string) => poUnescape(/"(.*)"\s*$/.exec(line)?.[1] ?? "");
  stripBom(text).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) {
      if (current.id !== undefined) finish();
      return;
    }
    if (line.startsWith("#.")) {
      const note = line.slice(2).trim();
      if (!/^(Key|SourceLocation):/i.test(note)) current.notes.push(note);
      return;
    }
    if (line.startsWith("#")) return;
    if (line.startsWith("msgctxt")) {
      if (current.strStart !== undefined) finish();
      current.ctx = quoted(line);
      field = "ctx";
    } else if (line.startsWith("msgid_plural")) {
      field = null;
    } else if (line.startsWith("msgid")) {
      if (current.strStart !== undefined) finish();
      current.id = quoted(line);
      field = "id";
    } else if (/^msgstr(\[0\])?\s/.test(line)) {
      current.str = quoted(line);
      current.strStart = current.strEnd = index;
      field = "str";
    } else if (line.startsWith("msgstr[")) {
      field = null; // other plural forms are left untouched
    } else if (line.startsWith('"') && field) {
      if (field === "ctx") current.ctx += quoted(line);
      if (field === "id") current.id += quoted(line);
      if (field === "str") {
        current.str += quoted(line);
        current.strEnd = index;
      }
    }
  });
  if (current.id !== undefined) finish();
  return entries;
}

/** "[ALIEN] Strange noises" → "ALIEN" */
const bracketSpeaker = (text: string) => /^\s*[[【]([^\]】]{1,40})[\]】]/.exec(text)?.[1]?.trim() ?? "";

export function parsePoTable(text: string): Table {
  const entries = parsePo(text);
  if (!entries.length) throw new Error("No translatable entries were found in this PO file.");
  return {
    headers: ["msgctxt", "msgid", "msgstr", "speaker", "note"],
    rows: entries.map((entry, index) => [entry.ctx?.replace(/^,/, "") || `entry_${index + 1}`, entry.id, entry.str, bracketSpeaker(entry.id), entry.notes.join("\n")]),
    locs: entries.map((_, entry) => ({ entry })),
    preset: { id: "msgctxt", src: "msgid", tr: "msgstr", spk: "speaker", note: "note" },
  };
}

// ---------------------------------------------------------------- js / txt (line based)

// A quoted or bare key, then ":" or "=", then a quoted string on the same line.
const JS_PAIR = /(?:(["'`])((?:\\.|(?!\1).)+?)\1|([A-Za-z_$][\w.$-]*))\s*[:=]\s*(["'`])((?:\\.|(?!\4)[^\\])*)\4/g;
const jsUnescape = (value: string) => value.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
export const jsEscape = (value: string, quote: string) =>
  value.replace(/\\/g, "\\\\").replaceAll(quote, "\\" + quote).replace(/\r?\n/g, "\\n");

/**
 * `key = "value"; // comment` and `"key": "value",` pairs (several per line are fine), with each
 * value's character span. A trailing comment on a single-pair line is kept (it often names the speaker).
 */
export function scanAssignments(text: string) {
  const out: { line: number; start: number; end: number; key: string; value: string; quote: string; comment: string }[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(\/\/|#|\/\*|\*)/.test(line)) return;
    const pairs = [...line.matchAll(JS_PAIR)];
    const tail = pairs.length === 1 ? line.slice(pairs[0]!.index! + pairs[0]![0].length) : "";
    const comment = /\/\/\s*(.*)$/.exec(tail)?.[1]?.trim() ?? "";
    for (const match of pairs) {
      const quote = match[4]!;
      const raw = match[5]!;
      const end = match.index! + match[0].length - 1;
      out.push({ line: index, start: end - raw.length, end, key: match[2] ?? match[3] ?? "", value: jsUnescape(raw), quote, comment });
    }
  });
  return out;
}

/** Scripts: simple key/text string pairs; a trailing `// Name` comment is read as the speaker. */
export function parseJsTable(text: string): Table {
  const items = scanAssignments(text).filter(item => hasLetters(item.value) || item.value === "");
  if (!items.length) throw new Error("No simple \"key\": \"text\" pairs were found. Mori reads JS files only for those pairs.");
  return {
    headers: ["key", "text", "speaker"],
    rows: items.map(item => [item.key, item.value, item.comment]),
    locs: items.map(({ line, start, end }) => ({ line, start, end })),
    preset: { id: "key", src: "text", tr: "", spk: "speaker", note: "" },
  };
}

/** `key = value` or `"key": "value",` lines become keyed rows; other non-empty lines are rows as they are. */
export function scanTextLines(text: string) {
  const out: { line: number; start: number; end: number; key: string; value: string }[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const kv = /^(\s*"?)([^"=:]{1,80}?)("?\s*[:=]\s*"?)(.*?)("?,?\s*)$/.exec(line);
    if (kv && (kv[4]!.trim() || kv[1]!.includes('"')) && !/\s{2,}/.test(kv[2]!) && !hasJapanese(kv[2]!)) {
      const start = kv[1]!.length + kv[2]!.length + kv[3]!.length;
      out.push({ line: index, start, end: start + kv[4]!.length, key: kv[2]!.trim(), value: kv[4]! });
    } else {
      const start = line.length - line.trimStart().length;
      out.push({ line: index, start, end: line.trimEnd().length, key: String(index + 1), value: line.trim() });
    }
  });
  return out;
}

export function parseTxtTable(text: string): Table {
  if (/^\s*msgid\s/m.test(text)) return parsePoTable(text);
  const items = scanTextLines(text);
  if (!items.length) throw new Error("This text file is empty.");
  return {
    headers: ["line", "text"],
    rows: items.map(item => [item.key, item.value]),
    locs: items.map(({ line, start, end }) => ({ line, start, end })),
    preset: { id: "line", src: "text", tr: "", spk: "", note: "" },
  };
}

// ---------------------------------------------------------------- docx / xlsx

export const DOCX_PARAGRAPH = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
export const DOCX_TEXT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
export const xmlDecode = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Texts of all non-empty paragraphs, in document order. Export counts paragraphs the same way. */
export const docxParagraphs = (xml: string) =>
  [...xml.matchAll(DOCX_PARAGRAPH)]
    .map(match => xmlDecode([...match[1]!.matchAll(DOCX_TEXT)].map(t => t[1]).join("")))
    .filter(text => text.trim());

function parseDocx(files: Map<string, Uint8Array>): Table {
  const bytes = files.get("word/document.xml");
  if (!bytes) throw new Error("The document body is missing.");
  // Word has no text IDs, so the paragraph number is used.
  const paragraphs = docxParagraphs(new TextDecoder().decode(bytes));
  if (!paragraphs.length) throw new Error("No text was found in this document.");
  return {
    headers: ["paragraph", "text"],
    rows: paragraphs.map((text, index) => [String(index + 1), text.trim()]),
    locs: paragraphs.map((_, p) => ({ p })),
    preset: { id: "paragraph", src: "text", tr: "", spk: "", note: "" },
  };
}

const parseXml = (bytes: Uint8Array) => new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");

export const columnIndex = (reference: string) => {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
};

/** Workbook tab names mapped to their worksheet XML paths inside the package. */
export function workbookSheets(files: Map<string, Uint8Array>) {
  const workbookBytes = files.get("xl/workbook.xml");
  const relsBytes = files.get("xl/_rels/workbook.xml.rels");
  if (!workbookBytes || !relsBytes) throw new Error("The workbook structure is missing.");
  const targets = new Map([...parseXml(relsBytes).getElementsByTagName("Relationship")]
    .map(rel => [rel.getAttribute("Id") ?? "", rel.getAttribute("Target") ?? ""]));
  return [...parseXml(workbookBytes).getElementsByTagName("sheet")].map(sheet => {
    const target = (targets.get(sheet.getAttribute("r:id") ?? "") ?? "").replace(/^\//, "");
    return { name: sheet.getAttribute("name") ?? "Sheet", path: target.startsWith("xl/") ? target : `xl/${target}` };
  });
}

/** One grid per non-empty tab. Grid rows and columns match the sheet's own positions (row 5 is grid[4]). */
function parseXlsx(files: Map<string, Uint8Array>): { sheet: string; grid: string[][] }[] {
  const sharedBytes = files.get("xl/sharedStrings.xml");
  const shared = sharedBytes ? [...parseXml(sharedBytes).getElementsByTagName("si")]
    .map(item => [...item.getElementsByTagName("t")].map(t => t.textContent ?? "").join("")) : [];
  const sheets: { sheet: string; grid: string[][] }[] = [];
  for (const { name, path } of workbookSheets(files)) {
    const bytes = files.get(path);
    if (!bytes) continue;
    const grid: string[][] = [];
    for (const rowElement of parseXml(bytes).getElementsByTagName("row")) {
      const r = Number(rowElement.getAttribute("r") ?? grid.length + 1) - 1;
      const cells: string[] = [];
      for (const cell of rowElement.getElementsByTagName("c")) {
        const type = cell.getAttribute("t");
        const value = cell.getElementsByTagName("v")[0]?.textContent ?? "";
        cells[columnIndex(cell.getAttribute("r") ?? "")] = type === "s" ? shared[Number(value)] ?? ""
          : type === "inlineStr" ? [...cell.getElementsByTagName("t")].map(t => t.textContent ?? "").join("")
          : value;
      }
      while (grid.length < r) grid.push([]);
      grid[r] = Array.from(cells, cell => cell ?? "");
    }
    if (grid.some(row => row.some(cell => cell.trim()))) sheets.push({ sheet: name, grid });
  }
  if (!sheets.length) throw new Error("No sheets with rows were found in this workbook.");
  return sheets;
}

export const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
export const fromBase64 = (base64: string) => Uint8Array.from(atob(base64), ch => ch.charCodeAt(0));

/** Reads one dropped or picked file into one or more tables (a workbook has one per tab). */
export async function readFile(file: File, path: string): Promise<StagedTable[]> {
  const kind = kindOf(file.name);
  if (!kind) throw new Error(`${file.name} isn’t a supported type.`);
  try {
    if (kind === "xlsx" || kind === "docx") {
      const buffer = await file.arrayBuffer();
      const files = await unzip(buffer);
      const original = toBase64(new Uint8Array(buffer));
      if (kind === "docx") return [{ ...parseDocx(files), name: file.name, path, kind, original }];
      const sheets = parseXlsx(files);
      return sheets.map(({ sheet, grid }) => ({
        ...tableFromRows(grid), name: sheets.length > 1 ? `${file.name} · ${sheet}` : file.name, path, kind, sheet, original,
      })).filter(table => table.rows.length);
    }
    const text = await file.text();
    // Unreal and other engines often save gettext PO with a .txt extension.
    const actual = kind === "txt" && /^\s*msgid\s/m.test(text) ? "po" : kind;
    const table = actual === "json" ? parseJsonTable(text)
      : actual === "csv" ? tableFromRows(parseCsv(text))
      : actual === "txt" ? parseTxtTable(text)
      : actual === "po" ? parsePoTable(text)
      : parseJsTable(text);
    return [{ ...table, name: file.name, path, kind: actual, original: text }];
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unknown error";
    throw new Error(`${file.name}: ${reason}`);
  }
}

/** Public Google Sheets: the CSV export of one tab. Private sheets go through the Google sign-in instead. */
export async function fetchPublicSheet(url: string): Promise<StagedTable> {
  const id = /\/spreadsheets\/d\/([\w-]+)/.exec(url)?.[1];
  if (!id) throw new Error("That doesn’t look like a Google Sheets link.");
  const gid = /[#?&]gid=(\d+)/.exec(url)?.[1];
  const exportUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
  let csv: string;
  if (nativeMori()) {
    csv = await nativeMori()!.readPublicSheet(id, gid);
  } else {
    let response: Response;
    try {
      response = await fetch(exportUrl);
    } catch {
      throw new Error("The browser couldn’t reach Google Sheets. Check the link is shared as “Anyone with the link”, or download the sheet as CSV and add the file.");
    }
    if (!response.ok) throw new Error(`Google Sheets answered ${response.status}. Check the link is shared as “Anyone with the link”.`);
    csv = await response.text();
  }
  const name = `Google Sheet ${id.slice(0, 6)}…`;
  return { ...tableFromRows(parseCsv(csv, ",")), name, path: `google-sheets/${name}`, kind: "sheet", original: csv };
}
