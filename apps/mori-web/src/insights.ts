import { editFinalText, recordFinalVersion, type MoriGlossaryEntry, type MoriRow } from "./model.ts";

// Placeholders, markup tags and printf-style codes that must survive translation.
const TOKEN_PATTERN = /\{[^{}\s]+\}|<\/?[a-zA-Z][^<>]*>|%(?:\d+\$)?[sdif]/g;

export const extractTokens = (text: string): string[] => text.match(TOKEN_PATTERN) ?? [];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const termPattern = (term: string) => new RegExp(`(^|[^\\p{L}])(${escapeRegExp(term)})(?=$|[^\\p{L}])`, "iu");

export type RowStatus = "pending" | "draft" | "translated";

/** Derived, never stored: a line is translated once the curated text is non-empty. */
export const statusOf = (row: MoriRow): RowStatus =>
  row.final.trim() ? "translated" : row.ai?.trim() || row.legacy?.trim() ? "draft" : "pending";

export const glossaryHits = (source: string, glossary: MoriGlossaryEntry[]): MoriGlossaryEntry[] =>
  glossary.filter(entry => entry.en.trim() && termPattern(entry.en.trim()).test(source));

export interface RowWarning {
  kind: "missing-token" | "extra-token" | "linebreaks" | "glossary" | "length" | "locked-empty";
  message: string;
  token?: string;
  term?: MoriGlossaryEntry;
}

/** Checks run only once a curated text exists; an empty line has nothing to check yet. */
export function checkRow(row: MoriRow, glossary: MoriGlossaryEntry[]): RowWarning[] {
  const warnings: RowWarning[] = [];
  const final = row.final;
  if (row.isLocked && !final.trim()) {
    warnings.push({ kind: "locked-empty", message: "Locked, but there is no curated translation." });
  }
  if (!final.trim()) return warnings;

  const sourceTokens = new Set(extractTokens(row.source));
  const finalTokens = new Set(extractTokens(final));
  for (const token of sourceTokens) {
    if (!finalTokens.has(token)) warnings.push({ kind: "missing-token", token, message: `Missing placeholder ${token}` });
  }
  for (const token of finalTokens) {
    if (!sourceTokens.has(token)) {
      warnings.push({ kind: "extra-token", token, message: `Placeholder ${token} is not in the source` });
    }
  }

  const sourceBreaks = row.source.split("\n").length - 1;
  const finalBreaks = final.split("\n").length - 1;
  if (sourceBreaks !== finalBreaks) {
    warnings.push({ kind: "linebreaks", message: `Line breaks differ: source ${sourceBreaks}, yours ${finalBreaks}` });
  }

  for (const term of glossaryHits(row.source, glossary)) {
    if (term.jp.trim() && !final.includes(term.jp.trim())) {
      warnings.push({ kind: "glossary", term, message: `“${term.en}” is usually ${term.jp}` });
    }
  }

  if (final.length > 12 && final.length > row.source.length * 1.1) {
    warnings.push({ kind: "length", message: `Longer than the source (${final.length} vs ${row.source.length} chars)` });
  }
  return warnings;
}

export const findDuplicates = (rows: MoriRow[], row: MoriRow): MoriRow[] => {
  const source = row.source.trim();
  return rows.filter(other => other.id !== row.id && other.source.trim() === source);
};

export const findUsages = (rows: MoriRow[], phrase: string, limit = 8): { total: number; rows: MoriRow[] } => {
  const needle = phrase.trim();
  if (!needle) return { total: 0, rows: [] };
  const pattern = termPattern(needle);
  const matches = rows.filter(row => pattern.test(row.source));
  return { total: matches.length, rows: matches.slice(0, limit) };
};

/** Replaces the curated text with another version, keeping the previous curated text in history. */
export const adoptText = (row: MoriRow, text: string): MoriRow =>
  row.isLocked ? row : recordFinalVersion(editFinalText(recordFinalVersion(row), text));

export type TextPart = { kind: "plain" | "token" | "term"; text: string; term?: MoriGlossaryEntry };

/** Splits text into plain runs, placeholder tokens and glossary terms for highlighting. */
export function markText(text: string, glossary: MoriGlossaryEntry[]): TextPart[] {
  const terms = glossary.filter(entry => entry.en.trim()).sort((a, b) => b.en.length - a.en.length);
  const alternatives = [TOKEN_PATTERN.source, ...terms.map(entry => escapeRegExp(entry.en.trim()))];
  const pattern = new RegExp(alternatives.join("|"), "giu");
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const value = match[0];
    const term = terms.find(entry => entry.en.trim().toLowerCase() === value.toLowerCase());
    if (term) {
      const before = text[start - 1];
      const after = text[start + value.length];
      const isWord = (ch: string | undefined) => ch !== undefined && /\p{L}/u.test(ch);
      if (isWord(before) || isWord(after)) continue;
    }
    if (start > last) parts.push({ kind: "plain", text: text.slice(last, start) });
    parts.push(term ? { kind: "term", text: value, term } : { kind: "token", text: value });
    last = start + value.length;
  }
  if (last < text.length) parts.push({ kind: "plain", text: text.slice(last) });
  return parts;
}

export type RowFilter = "all" | "todo" | "draft" | "translated" | "locked" | "warnings";

export function matchesFilter(row: MoriRow, filter: RowFilter, glossary: MoriGlossaryEntry[]): boolean {
  switch (filter) {
    case "all": return true;
    case "todo": return !row.isLocked && statusOf(row) !== "translated";
    case "draft": return statusOf(row) === "draft";
    case "translated": return statusOf(row) === "translated";
    case "locked": return row.isLocked === true;
    case "warnings": return checkRow(row, glossary).length > 0;
  }
}

export interface ViewFilters {
  filter: RowFilter;
  query: string;
  /** "any", "none" (unassigned) or a character ID. */
  speaker: string;
  /** Source file path; null shows every file. */
  file: string | null;
}

/** Lines the Matrix shows. The active line stays visible even when it stops matching the filters. */
export function visibleRows(rows: MoriRow[], view: ViewFilters, names: Map<string, string>, activeId: string | null, glossary: MoriGlossaryEntry[]): MoriRow[] {
  const query = view.query.trim().toLowerCase();
  return rows.filter(row => {
    if (row.id === activeId) return true;
    if (view.file && row.sourceFile !== view.file) return false;
    if (view.speaker === "none" ? row.characterId : view.speaker !== "any" && row.characterId !== view.speaker) return false;
    if (!matchesFilter(row, view.filter, glossary)) return false;
    if (!query) return true;
    const speaker = row.characterId ? names.get(row.characterId) : undefined;
    return [row.id, row.source, row.legacy, row.ai, row.final, speaker]
      .some(value => typeof value === "string" && value.toLowerCase().includes(query));
  });
}

/** Locking first records the curated text so the final version is always in history. */
export const toggleLock = (row: MoriRow): MoriRow =>
  row.isLocked ? { ...row, isLocked: false } : { ...recordFinalVersion(row), isLocked: true };

export const withSpeaker = (row: MoriRow, characterId: string | undefined): MoriRow => {
  const { characterId: _previous, ...rest } = row;
  return characterId ? { ...rest, characterId } : rest;
};
