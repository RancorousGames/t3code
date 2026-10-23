// Compatibility shape for existing .mori project files; not a new persistence format.
export interface VersionEntry {
  text: string;
  type: "dev" | "ai" | "curated";
  timestamp: number;
}

export interface MoriRow {
  id: string;
  source: string;
  legacy?: string;
  ai?: string;
  final: string;
  status: "pending" | "draft" | "translated";
  characterId?: string;
  sourceFile?: string;
  isLocked?: boolean;
  history?: VersionEntry[];
  note?: string;
}

export interface MoriCharacter {
  id: string;
  name: string;
  role: string;
  tone: string;
  description: string;
}

export interface MoriGlossaryEntry {
  id: string;
  en: string;
  jp: string;
  explanation: string;
}

export interface MoriProject {
  id: string;
  name: string;
  rows: MoriRow[];
  characters: MoriCharacter[];
  glossary: MoriGlossaryEntry[];
  context: { global: string; project: string };
  lastModified: string;
  sourceFiles?: string[];
  [additionalField: string]: unknown;
}

export const createDemoProject = (): MoriProject => ({
  id: "mori_skeleton_demo",
  name: "Demo – not a real translation project",
  rows: [
    { id: "intro.001", source: "Welcome back.", legacy: "おかえりなさい。", ai: "おかえり。", final: "", status: "draft", characterId: "GUIDE" },
    { id: "intro.002", source: "I thought you were gone.", legacy: "", ai: "", final: "", status: "pending", characterId: "GUIDE" },
    { id: "ui.save", source: "Save game", legacy: "ゲームを保存", ai: "", final: "セーブ", status: "translated", isLocked: true, characterId: "SYSTEM" },
  ],
  characters: [
    { id: "SYSTEM", name: "System", role: "UI", tone: "Neutral", description: "Short, consistent interface terminology." },
    { id: "GUIDE", name: "Guide", role: "NPC", tone: "Friendly", description: "Warm but concise dialogue." },
  ],
  glossary: [{ id: "glossary_1", en: "Save game", jp: "セーブ", explanation: "Preferred UI wording." }],
  context: { global: "Preserve placeholders, markup, and control tokens.", project: "Example project for skeleton review only." },
  lastModified: new Date().toISOString(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const parseRow = (value: unknown): MoriRow => {
  if (!isRecord(value) || !isString(value.id) || !isString(value.source)) {
    throw new Error("Invalid translation row: expected id and source strings.");
  }
  if (value.status !== undefined && !["translated", "draft", "pending"].includes(String(value.status))) {
    throw new Error("Unsupported translation row status. File not loaded to avoid data loss.");
  }
  if (value.history !== undefined && (!Array.isArray(value.history) || !value.history.every(
    entry => isRecord(entry) && isString(entry.text) &&
      ["dev", "ai", "curated"].includes(String(entry.type)) &&
      typeof entry.timestamp === "number",
  ))) throw new Error("Unsupported version history. File not loaded to avoid data loss.");
  return {
    ...value,
    id: value.id,
    source: value.source,
    final: isString(value.final) ? value.final : "",
    status: value.status === "translated" || value.status === "draft" ? value.status : "pending",
  } as MoriRow;
};

export const parseMoriProject = (json: unknown): MoriProject => {
  if (!isRecord(json) || !isString(json.id) || !isString(json.name) || !Array.isArray(json.rows)) {
    throw new Error("Not a valid .mori project. Expected a project ID, name, and rows.");
  }
  if (json.rows.length > 200_000) throw new Error("Project exceeds skeleton's 200,000-row safety limit.");
  const context = isRecord(json.context) ? json.context : {};
  if (json.characters !== undefined && (!Array.isArray(json.characters) || !json.characters.every(
    x => isRecord(x) && isString(x.id) && isString(x.name) &&
      isString(x.role) && isString(x.tone) && isString(x.description),
  ))) throw new Error("Unsupported character definitions. File not loaded to avoid data loss.");
  if (json.glossary !== undefined && (!Array.isArray(json.glossary) || !json.glossary.every(
    x => isRecord(x) && isString(x.id) && isString(x.en) &&
      isString(x.jp) && isString(x.explanation),
  ))) throw new Error("Unsupported glossary. File not loaded to avoid data loss.");
  return {
    ...json,
    id: json.id,
    name: json.name,
    rows: json.rows.map(parseRow),
    characters: Array.isArray(json.characters) ? json.characters as MoriCharacter[] : [],
    glossary: Array.isArray(json.glossary) ? json.glossary as MoriGlossaryEntry[] : [],
    context: {
      ...context,
      global: isString(context.global) ? context.global : "",
      project: isString(context.project) ? context.project : "",
    },
    lastModified: isString(json.lastModified) ? json.lastModified : new Date().toISOString(),
  };
};

export const editFinalText = (row: MoriRow, text: string): MoriRow =>
  row.isLocked
    ? row
    : {
        ...row,
        final: text,
        status: text.trim() ? "translated" : row.ai ? "draft" : "pending",
      };

export const recordFinalVersion = (row: MoriRow): MoriRow => {
  if (!row.final.trim() || row.isLocked) return row;
  const history = row.history ?? [];
  if (history.at(-1)?.text === row.final && history.at(-1)?.type === "curated") return row;
  return { ...row, history: [...history, { text: row.final, type: "curated", timestamp: Date.now() }] };
};
