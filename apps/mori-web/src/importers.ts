import { unzip } from "./zip.ts";
import { nativeMori } from "./backend.ts";

export type SourceKind = "json" | "csv" | "txt" | "po" | "js" | "xlsx" | "docx" | "sheet";

/** A rectangular table: the first row is the header, every row has one cell per header. */
export interface Table {
  headers: string[];
  rows: string[][];
}

export interface StagedTable extends Table {
  /** Display name, e.g. "chapter1.json" or "Hollowmere UI · Menus". */
  name: string;
  /** Where the source lives, e.g. "dialogue/chapter1.json". Every line keeps this as its source file. */
  path: string;
  kind: SourceKind;
}

export const ACCEPTED_EXTENSIONS = ["json", "docx", "xlsx", "csv", "po", "js", "txt"] as const;

export function kindOf(filename: string): SourceKind | null {
  const extension = filename.split(".").pop()?.toLowerCase();
  return ACCEPTED_EXTENSIONS.find(ext => ext === extension) ?? null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** RFC 4180 CSV: quoted cells may contain commas, quotes (doubled) and line breaks. */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
    } else if (ch === ",") {
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

/** Turns a grid into a table. Blank rows are dropped; a row with more cells than headers is an error, not a silent cut. */
export function tableFromRows(grid: string[][]): Table {
  const nonBlank = grid.filter(row => row.some(cell => cell.trim() !== ""));
  const [head = [], ...body] = nonBlank;
  const seen = new Map<string, number>();
  const headers = head.map((raw, index) => {
    const base = raw.trim() || `Column ${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
  const rows = body.map((cells, rowIndex) => {
    if (cells.length > headers.length && cells.slice(headers.length).some(cell => cell.trim() !== "")) {
      throw new Error(`Row ${rowIndex + 2} has more cells than the header row. Nothing was imported from this file.`);
    }
    return headers.map((_, index) => cells[index] ?? "");
  });
  return { headers, rows };
}

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

function flatten(value: unknown, path: string): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (typeof value === "number" || typeof value === "boolean") return [[path, String(value)]];
  if (Array.isArray(value)) return value.flatMap((item, index) => flatten(item, `${path}[${index}]`));
  if (isRecord(value)) return Object.entries(value).flatMap(([key, item]) => flatten(item, path ? `${path}.${key}` : key));
  return [];
}

/** Arrays of objects keep their own columns. Anything else is flattened to key/text pairs with dotted paths. */
export function parseJsonTable(text: string): Table {
  const data: unknown = JSON.parse(text);
  if (Array.isArray(data) && data.length && data.every(isRecord)) {
    const headers = [...new Set(data.flatMap(item => Object.keys(item)))];
    return { headers, rows: data.map(item => headers.map(header => stringify(item[header]))) };
  }
  const entries = flatten(data, "");
  if (!entries.length) throw new Error("No text was found in this JSON file.");
  return { headers: ["key", "text"], rows: entries.map(([key, text]) => [key, text]) };
}

/** Plain text: one line per row. Line numbers become the IDs. */
export function parseTxtTable(text: string): Table {
  const rows = text.split(/\r?\n/).flatMap((line, index) => (line.trim() ? [[String(index + 1), line]] : []));
  if (!rows.length) throw new Error("This text file is empty.");
  return { headers: ["line", "text"], rows };
}

const unescapePo = (value: string) => value.replace(/\\(["\\nt])/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char));

/** gettext PO: msgctxt, msgid and msgstr per entry. The header entry (empty msgid) is skipped. */
export function parsePoTable(text: string): Table {
  type Entry = { msgctxt?: string; msgid?: string; msgstr?: string };
  const entries: Entry[] = [];
  let current: Entry = {};
  let field: keyof Entry | null = null;
  const finish = () => {
    if (current.msgid !== undefined) entries.push(current);
    current = {};
    field = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      finish();
      continue;
    }
    if (line.startsWith("#")) continue;
    const start = /^(msgctxt|msgid|msgstr)\s+"(.*)"$/.exec(line);
    if (start) {
      const name = start[1] as keyof Entry;
      if ((name === "msgid" && current.msgid !== undefined) || (name === "msgctxt" && current.msgctxt !== undefined)) finish();
      current[name] = unescapePo(start[2] ?? "");
      field = name;
      continue;
    }
    const continuation = /^"(.*)"$/.exec(line);
    if (continuation && field) current[field] = (current[field] ?? "") + unescapePo(continuation[1] ?? "");
  }
  finish();
  const rows = entries.filter(entry => entry.msgid !== "").map(entry => [entry.msgctxt ?? "", entry.msgid ?? "", entry.msgstr ?? ""]);
  if (!rows.length) throw new Error("No translatable entries were found in this PO file.");
  return { headers: ["msgctxt", "msgid", "msgstr"], rows };
}

/** Scripts: only simple "key": "text" string pairs are read. Other code is ignored, and the file is refused if nothing matches. */
export function parseJsTable(text: string): Table {
  const pattern = /["']?([A-Za-z_][\w.-]*)["']?\s*:\s*(["'`])((?:\\.|(?!\2)[^\\\n])*)\2/g;
  const rows: string[][] = [];
  for (const match of text.matchAll(pattern)) {
    rows.push([match[1] ?? "", unescapePo(match[3] ?? "")]);
  }
  if (!rows.length) throw new Error("No simple \"key\": \"text\" pairs were found. Mori reads JS files only for those pairs.");
  return { headers: ["key", "text"], rows };
}

const parseXml = (bytes: Uint8Array) => new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");

const columnIndex = (reference: string) => {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
};

async function parseXlsx(files: Map<string, Uint8Array>): Promise<{ sheet: string; table: Table }[]> {
  const workbookBytes = files.get("xl/workbook.xml");
  const relsBytes = files.get("xl/_rels/workbook.xml.rels");
  if (!workbookBytes || !relsBytes) throw new Error("The workbook structure is missing.");
  const sharedBytes = files.get("xl/sharedStrings.xml");
  const shared = sharedBytes ? [...parseXml(sharedBytes).getElementsByTagName("si")]
    .map(item => [...item.getElementsByTagName("t")].map(t => t.textContent ?? "").join("")) : [];
  const targets = new Map([...parseXml(relsBytes).getElementsByTagName("Relationship")]
    .map(rel => [rel.getAttribute("Id") ?? "", rel.getAttribute("Target") ?? ""]));

  const sheets: { sheet: string; table: Table }[] = [];
  for (const sheet of parseXml(workbookBytes).getElementsByTagName("sheet")) {
    const target = (targets.get(sheet.getAttribute("r:id") ?? "") ?? "").replace(/^\//, "");
    const path = target.startsWith("xl/") ? target : `xl/${target}`;
    const bytes = files.get(path);
    if (!bytes) continue;
    const grid: string[][] = [];
    for (const rowElement of parseXml(bytes).getElementsByTagName("row")) {
      const cells: string[] = [];
      for (const cell of rowElement.getElementsByTagName("c")) {
        const type = cell.getAttribute("t");
        const value = cell.getElementsByTagName("v")[0]?.textContent ?? "";
        const text = type === "s" ? shared[Number(value)] ?? ""
          : type === "inlineStr" ? [...cell.getElementsByTagName("t")].map(t => t.textContent ?? "").join("")
          : value;
        cells[columnIndex(cell.getAttribute("r") ?? "")] = text;
      }
      grid.push(Array.from(cells, cell => cell ?? ""));
    }
    const table = tableFromRows(grid);
    if (table.headers.length && table.rows.length) sheets.push({ sheet: sheet.getAttribute("name") ?? "Sheet", table });
  }
  if (!sheets.length) throw new Error("No sheets with rows were found in this workbook.");
  return sheets;
}

async function parseDocx(files: Map<string, Uint8Array>): Promise<Table> {
  const bytes = files.get("word/document.xml");
  if (!bytes) throw new Error("The document body is missing.");
  // Each non-empty paragraph becomes a row. Word has no text IDs, so the paragraph number is used.
  const paragraphs = [...parseXml(bytes).getElementsByTagName("w:p")]
    .map(p => [...p.getElementsByTagName("w:t")].map(t => t.textContent ?? "").join(""))
    .filter(text => text.trim());
  if (!paragraphs.length) throw new Error("No text was found in this document.");
  return { headers: ["paragraph", "text"], rows: paragraphs.map((text, index) => [String(index + 1), text]) };
}

/** Reads one dropped or picked file into one or more tables (a workbook has one per sheet). */
export async function readFile(file: File, path: string): Promise<StagedTable[]> {
  const kind = kindOf(file.name);
  if (!kind) throw new Error(`${file.name} isn’t a supported type.`);
  try {
    if (kind === "xlsx" || kind === "docx") {
      const files = await unzip(await file.arrayBuffer());
      if (kind === "docx") {
        const table = await parseDocx(files);
        return [{ ...table, name: file.name, path, kind }];
      }
      const sheets = await parseXlsx(files);
      return sheets.map(({ sheet, table }) => ({ ...table, name: `${file.name} · ${sheet}`, path, kind }));
    }
    const text = await file.text();
    const table = kind === "json" ? parseJsonTable(text)
      : kind === "csv" ? tableFromRows(parseCsv(text))
      : kind === "txt" ? parseTxtTable(text)
      : kind === "po" ? parsePoTable(text)
      : parseJsTable(text);
    return [{ ...table, name: file.name, path, kind }];
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unknown error";
    throw new Error(`${file.name}: ${reason}`);
  }
}

/** Public Google Sheets only: the CSV export of one tab. Private sheets need Google sign-in, which this build doesn't have. */
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
  const table = tableFromRows(parseCsv(csv));
  const name = `Google Sheet ${id.slice(0, 6)}…`;
  return { ...table, name, path: `google-sheets/${name}`, kind: "sheet" };
}
