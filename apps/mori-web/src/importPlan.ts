import { hasJapanese, type RowLoc, type SourceKind, type StagedTable } from "./importers.ts";
import type { MoriCharacter, MoriProject, MoriRow } from "./model.ts";
import type { CharacterTemplate } from "./templates.ts";

// Turns staged sources into project lines. Pure so the rules can be tested without the UI.

/** Which source column feeds each part of the unified model. "" means not mapped. */
export interface Mapping {
  id: string;
  src: string;
  tr: string;
  spk: string;
  note: string;
}

export const EMPTY_MAPPING: Mapping = { id: "", src: "", tr: "", spk: "", note: "" };

/**
 * What export needs to put translations back into one imported file (or workbook tab).
 * Saved on the project as `sources`; the untouched files are saved as `originals` (path → text or base64).
 */
export interface SourceRecord {
  path: string;
  kind: SourceKind;
  sheet?: string;
  headerRow?: number;
  /** Tabular: grid column of the mapped translation; absent means export adds a "Japanese" column after lastCol. */
  targetCol?: number;
  lastCol?: number;
  /** JSON list: object key of the translation ("ja" when none was mapped). */
  targetKey?: string;
}
export type Originals = Record<string, string>;

/** Sources with the same headers share a schema, and each schema gets its own mapping. */
export const signatureOf = (headers: string[]) => headers.join("\u001f");

const ROLE_PATTERNS: Record<keyof Mapping, RegExp[]> = {
  // Earlier patterns win.
  tr: [/^(japanese|ja|jp|jpn|ja[-_ ]?jp|translation|text[ _-]?ja|msgstr|日本語|和訳)$/i, /japanese|日本語|\[ja\]|\bja\b|\bjp\b/i, /\btranslat(ion|ed)\b|訳/i],
  src: [/^(english|en|eng|en[-_ ]?(us|gb)|source|text[ _-]?en|src|original|msgid|英語)$/i, /english|\ben\b|英語/i,
    /^(original text|text|string|content|value|message|line|dialogue)$/i, /source|original/i],
  id: [/^(text[ _-]?id|string[ _-]?id|id|key|msgctxt|identifier|loc ?key|code)$/i, /\bid\b|key|identifier|variable/i],
  spk: [/^(speaker|character|who|actor|voice|npc|chara)$/i, /speaker|character|actor/i],
  note: [/^(notes?|context|comments?|desc|description|memo|hint|remarks?|max[ _-]?length)$/i, /comment|note|context|memo|direction/i],
};

/**
 * Guesses column roles from header names, then from the content of the first rows:
 * a column that is mostly Japanese is the translation, a unique code-like column is the ID,
 * and the column with the most English prose is the source.
 */
export function guessMapping(headers: string[], rows: string[][] = []): Mapping {
  const mapping: Mapping = { ...EMPTY_MAPPING };
  const taken = new Set<string>();
  const sample = rows.slice(0, 300);
  const values = (header: string) => sample.map(row => (row[headers.indexOf(header)] ?? "").trim()).filter(Boolean);
  const share = (header: string, test: (v: string) => boolean) => {
    const filled = values(header);
    return filled.length ? filled.filter(test).length / filled.length : 0;
  };
  const unique = (header: string) => {
    const filled = values(header);
    return !sample.length || (filled.length > 0 && new Set(filled).size / filled.length > 0.9);
  };
  const mostlyJapanese = (header: string) => share(header, hasJapanese) > 0.3;
  const take = (role: keyof Mapping, header: string | undefined) => {
    if (!header) return;
    mapping[role] = header;
    taken.add(header);
  };
  const pick = (role: keyof Mapping, ok: (header: string) => boolean = () => true) => {
    for (const pattern of ROLE_PATTERNS[role]) {
      const header = headers.find(h => !taken.has(h) && pattern.test(h.trim()) && ok(h));
      if (header) return take(role, header);
    }
  };

  pick("tr");
  if (!mapping.tr) take("tr", headers.find(h => !taken.has(h) && mostlyJapanese(h)));
  pick("src", h => !sample.length || !mostlyJapanese(h));
  pick("id", unique);
  pick("spk");
  pick("note");
  if (!mapping.src && sample.length) {
    // The non-Japanese column with the most letters overall.
    const scored = headers.filter(h => !taken.has(h)).map(h => ({
      h, score: values(h).filter(v => /\p{L}/u.test(v) && !hasJapanese(v)).reduce((sum, v) => sum + v.length, 0),
    })).sort((a, b) => b.score - a.score);
    if (scored[0]?.score) take("src", scored[0].h);
  }
  if (!mapping.id && sample.length) {
    take("id", headers.find(h => !taken.has(h) && unique(h) && share(h, v => /^[\w.\-/:[\]#]{1,64}$/.test(v)) > 0.8 && values(h).length >= sample.length * 0.8));
  }
  return mapping;
}

/** The mapping a staged source starts with: its own fields for structured formats, a guess otherwise. */
export const initialMapping = (source: Pick<StagedTable, "headers" | "rows" | "preset">) =>
  source.preset ?? guessMapping(source.headers, source.rows);

export interface PlanInput {
  sources: StagedTable[];
  mappingFor: (headers: string[]) => Mapping;
  characterTemplates: CharacterTemplate[];
  /** Adding to an existing project: its speakers are reused, and lines it already has are skipped. */
  existing?: MoriProject;
}

export interface ImportPlan {
  rows: MoriRow[];
  /** New characters only (existing ones are reused by name). */
  characters: MoriCharacter[];
  /** Blocking problems. The project can't be created while any remain. */
  issues: string[];
  /** Non-blocking notes shown before creating, such as skipped empty lines. */
  warnings: string[];
  sourceFiles: string[];
  sources: SourceRecord[];
  originals: Originals;
  /** Lines already in the project whose file was added again: their position in the new copy of the file. */
  relocated: Record<string, RowLoc>;
  stats: { lines: number; existing: number; duplicateLines: number; speakers: number; sheets: number; alreadyPresent: number };
}

const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";
/** Prefix of generated IDs: the file name without extension, plus the tab for multi-tab workbooks ("Book/Menus"). */
const labelOf = (source: Pick<StagedTable, "name">) => source.name.replace(/\.[^.·]+( · |$)/, "$1").replace(" · ", "/");

/** A readable position for generated IDs: row number, line number, paragraph or entry. */
const positionOf = (loc: RowLoc | undefined, index: number) =>
  loc?.r !== undefined ? loc.r + 1 : loc?.line !== undefined ? loc.line + 1 : loc?.p !== undefined ? loc.p + 1 : loc?.entry !== undefined ? loc.entry + 1 : index + 1;

export function planImport({ sources, mappingFor, characterTemplates, existing }: PlanInput): ImportPlan {
  const issues: string[] = [];
  const warnings: string[] = [];
  const rows: MoriRow[] = [];
  const characters: MoriCharacter[] = [];
  const records: SourceRecord[] = [];
  const originals: Originals = {};
  const owners = new Map<string, string>((existing?.rows ?? []).map(row => [row.id, row.sourceFile ?? ""]));
  const speakerIds = new Map<string, string>((existing?.characters ?? []).map(c => [c.name.trim().toLowerCase(), c.id]));
  const takenIds = new Set<string>((existing?.characters ?? []).map(c => c.id));
  const sourceFiles = new Set<string>();
  const relocated: Record<string, RowLoc> = {};
  let alreadyPresent = 0;

  // Lines with no speaker go to Narrator. Speakers match by name, case-insensitively.
  const characterFor = (label: string): string => {
    const name = label.trim() || "Narrator";
    const key = name.toLowerCase();
    const known = speakerIds.get(key);
    if (known) return known;
    const base = slug(name);
    let id = base;
    for (let n = 2; takenIds.has(id); n++) id = `${base}-${n}`;
    takenIds.add(id);
    speakerIds.set(key, id);
    const template = characterTemplates.find(t => t.name.trim().toLowerCase() === key);
    characters.push({
      id,
      name,
      role: template?.role ?? "",
      tone: template?.tone ?? "",
      description: template?.description ?? (existing ? "First seen in a file added later." : ""),
    });
    return id;
  };

  for (const source of sources) {
    const mapping = mappingFor(source.headers);
    if (!mapping.src) {
      issues.push(`${source.name}: choose the Source text column.`);
      continue;
    }
    const column = (name: string) => (name ? source.headers.indexOf(name) : -1);
    const idColumn = column(mapping.id);
    const srcColumn = column(mapping.src);
    const trColumn = column(mapping.tr);
    const spkColumn = column(mapping.spk);
    const noteColumn = column(mapping.note);
    if (srcColumn < 0) {
      issues.push(`${source.name}: a mapped column is missing from this file.`);
      continue;
    }
    const label = labelOf(source);

    source.rows.forEach((cells, index) => {
      const loc = source.locs[index];
      const text = cells[srcColumn] ?? "";
      let id = idColumn >= 0 ? (cells[idColumn] ?? "").trim() : "";
      if (!id) id = `${label}:${positionOf(loc, index)}`;
      if (!text.trim()) {
        warnings.push(`${id} has no source text and was skipped (${source.name}).`);
        return;
      }
      const owner = owners.get(id);
      if (owner !== undefined) {
        // Re-adding a file to its project only brings in the new lines.
        if (existing && owner === source.path && existing.rows.some(row => row.id === id)) {
          alreadyPresent++;
          if (loc && source.original !== undefined) relocated[id] = source.sheet ? { ...loc, sheet: source.sheet } : loc;
          return;
        }
        let n = 2;
        while (owners.has(`${id} (${n})`)) n++;
        warnings.push(`Text ID “${id}” appears more than once, so the copy in ${source.name} became “${id} (${n})”.`);
        id = `${id} (${n})`;
      }
      owners.set(id, source.path);

      const existingText = trColumn >= 0 ? (cells[trColumn] ?? "") : "";
      const note = noteColumn >= 0 ? (cells[noteColumn] ?? "").trim() : "";
      const speaker = spkColumn >= 0 ? (cells[spkColumn] ?? "") : "";
      rows.push({
        id,
        source: text,
        final: "",
        status: existingText.trim() ? "draft" : "pending",
        sourceFile: source.path,
        characterId: characterFor(speaker),
        ...(existingText.trim() ? { legacy: existingText } : {}),
        ...(note ? { note } : {}),
        ...(loc && source.original !== undefined ? { loc: source.sheet ? { ...loc, sheet: source.sheet } : loc } : {}),
      });
      sourceFiles.add(source.path);
    });

    if (source.original !== undefined) {
      originals[source.path] = source.original;
      records.push({
        path: source.path,
        kind: source.kind,
        ...(source.sheet ? { sheet: source.sheet } : {}),
        ...(source.headerRow !== undefined ? { headerRow: source.headerRow } : {}),
        ...(source.colIndex && trColumn >= 0 ? { targetCol: source.colIndex[trColumn] } : {}),
        ...(source.colIndex?.length ? { lastCol: Math.max(...source.colIndex) } : {}),
        ...(source.kind === "json" && !source.preset ? { targetKey: mapping.tr || "ja" } : {}),
      });
    }
  }

  // Re-adding files the project already has is allowed: it refreshes their saved copies for export.
  if (!rows.length && !issues.length && !alreadyPresent) issues.push("None of the staged lines have source text to import.");

  const bySource = new Map<string, number>();
  for (const row of rows) {
    const key = row.source.trim();
    bySource.set(key, (bySource.get(key) ?? 0) + 1);
  }
  const duplicateLines = rows.filter(row => (bySource.get(row.source.trim()) ?? 0) > 1).length;

  return {
    rows,
    characters,
    issues,
    warnings,
    sourceFiles: [...sourceFiles],
    sources: records,
    originals,
    relocated,
    stats: {
      lines: rows.length,
      existing: rows.filter(row => row.legacy).length,
      duplicateLines,
      speakers: characters.length,
      sheets: sources.filter(source => source.kind === "sheet").length,
      alreadyPresent,
    },
  };
}

/**
 * Adds a plan to an existing project. A file added again replaces its saved copy, so the lines
 * already in the project move to their position in the new copy (or lose it when they're gone from it).
 */
export function appendPlan(project: MoriProject, plan: ImportPlan): MoriProject {
  const replaced = new Set(plan.sources.map(s => `${s.path}\u001f${s.sheet ?? ""}`));
  const refreshed = new Set(Object.keys(plan.originals));
  const rows = project.rows.map(row => {
    if (!row.sourceFile || !refreshed.has(row.sourceFile)) return row;
    const { loc: _old, ...rest } = row;
    const loc = plan.relocated[row.id];
    return loc ? { ...rest, loc } : rest;
  });
  return {
    ...project,
    rows: [...rows, ...plan.rows],
    characters: [...project.characters, ...plan.characters],
    sourceFiles: [...new Set([...(project.sourceFiles ?? []), ...plan.sourceFiles])],
    sources: [...(project.sources ?? []).filter(s => !replaced.has(`${s.path}\u001f${s.sheet ?? ""}`)), ...plan.sources],
    originals: { ...(project.originals ?? {}), ...plan.originals },
    lastModified: new Date().toISOString(),
  };
}

/** The first rows as the project will see them, for the "As Mori sees it" preview. */
export function processedPreview(source: StagedTable, mapping: Mapping, limit = 6) {
  const at = (name: string, cells: string[]) => {
    const index = source.headers.indexOf(name);
    return name && index >= 0 ? (cells[index] ?? "") : "";
  };
  return source.rows.slice(0, limit).map((cells, index) => ({
    id: at(mapping.id, cells) || `${labelOf(source)}:${positionOf(source.locs[index], index)}`,
    speaker: at(mapping.spk, cells),
    source: at(mapping.src, cells),
    existing: at(mapping.tr, cells),
  }));
}
