import type { StagedTable } from "./importers.ts";
import type { MoriCharacter, MoriRow } from "./model.ts";
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

/** Sources with the same headers share a schema, and each schema gets its own mapping. */
export const signatureOf = (headers: string[]) => headers.join("\u001f");

export function guessMapping(headers: string[]): Mapping {
  const pick = (...patterns: RegExp[]) => headers.find(header => patterns.some(pattern => pattern.test(header.trim()))) ?? "";
  const mapping: Mapping = {
    id: pick(/^(text[ _-]?id|string[ _-]?id|id|key|msgctxt|name)$/i),
    src: pick(/^(english|en|source|text[ _-]?en|src|original|msgid)$/i, /english|source/i),
    tr: pick(/^(japanese|ja|jp|translation|text[ _-]?ja|msgstr)$/i, /japanese|translation/i),
    spk: pick(/^(speaker|character|who|actor|voice)$/i),
    note: pick(/^(notes?|context|comment|max[ _-]?length)$/i),
  };
  // The same column can't feed two parts of the model.
  return { ...mapping, tr: mapping.tr === mapping.src ? "" : mapping.tr };
}

export interface PlanInput {
  sources: StagedTable[];
  mappingFor: (headers: string[]) => Mapping;
  characterTemplates: CharacterTemplate[];
}

export interface ImportPlan {
  rows: MoriRow[];
  characters: MoriCharacter[];
  /** Blocking problems. The project can't be created while any remain. */
  issues: string[];
  /** Non-blocking notes shown before creating, such as skipped empty lines. */
  warnings: string[];
  sourceFiles: string[];
  stats: { lines: number; existing: number; duplicateLines: number; speakers: number; sheets: number };
}

const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";

export function planImport({ sources, mappingFor, characterTemplates }: PlanInput): ImportPlan {
  const issues: string[] = [];
  const warnings: string[] = [];
  const rows: MoriRow[] = [];
  const characters: MoriCharacter[] = [];
  const owners = new Map<string, string>();
  const speakerIds = new Map<string, string>();
  const takenIds = new Set<string>();
  const sourceFiles = new Set<string>();

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
      description: template?.description ?? "",
    });
    return id;
  };

  for (const source of sources) {
    const mapping = mappingFor(source.headers);
    if (!mapping.id || !mapping.src) {
      issues.push(`${source.name}: choose the Text ID and Source text columns.`);
      continue;
    }
    const column = (name: string) => (name ? source.headers.indexOf(name) : -1);
    const idColumn = column(mapping.id);
    const srcColumn = column(mapping.src);
    const trColumn = column(mapping.tr);
    const spkColumn = column(mapping.spk);
    const noteColumn = column(mapping.note);
    if (idColumn < 0 || srcColumn < 0) {
      issues.push(`${source.name}: a mapped column is missing from this file.`);
      continue;
    }

    source.rows.forEach((cells, index) => {
      const id = (cells[idColumn] ?? "").trim();
      const text = cells[srcColumn] ?? "";
      if (!id) {
        issues.push(`${source.name}, row ${index + 1}: the Text ID is empty.`);
        return;
      }
      if (!text.trim()) {
        warnings.push(`${id} has no source text and was skipped (${source.name}).`);
        return;
      }
      const owner = owners.get(id);
      if (owner !== undefined) {
        issues.push(`Text ID “${id}” appears more than once (${owner} and ${source.path}).`);
        return;
      }
      owners.set(id, source.path);

      const existing = trColumn >= 0 ? (cells[trColumn] ?? "") : "";
      const note = noteColumn >= 0 ? (cells[noteColumn] ?? "").trim() : "";
      const speaker = spkColumn >= 0 ? (cells[spkColumn] ?? "") : "";
      rows.push({
        id,
        source: text,
        final: "",
        status: existing.trim() ? "draft" : "pending",
        sourceFile: source.path,
        characterId: characterFor(speaker),
        ...(existing.trim() ? { legacy: existing } : {}),
        ...(note ? { note } : {}),
      });
      sourceFiles.add(source.path);
    });
  }

  if (!rows.length && !issues.length) issues.push("None of the staged lines have source text to import.");

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
    stats: {
      lines: rows.length,
      existing: rows.filter(row => row.legacy).length,
      duplicateLines,
      speakers: characters.length,
      sheets: sources.filter(source => source.kind === "sheet").length,
    },
  };
}

/** The first rows as the project will see them, for the "As Mori sees it" preview. */
export function processedPreview(source: StagedTable, mapping: Mapping, limit = 6) {
  const at = (name: string, cells: string[]) => {
    const index = source.headers.indexOf(name);
    return name && index >= 0 ? (cells[index] ?? "") : "";
  };
  return source.rows.slice(0, limit).map(cells => ({
    id: at(mapping.id, cells),
    speaker: at(mapping.spk, cells),
    source: at(mapping.src, cells),
    existing: at(mapping.tr, cells),
  }));
}
