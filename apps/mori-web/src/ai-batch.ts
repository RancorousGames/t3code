import type { MoriProject, MoriRow } from "./model.ts";

export const AI_BATCH_LIMIT = 8;
export function nextDraftCandidates(project: MoriProject, limit = AI_BATCH_LIMIT): MoriRow[] {
  return project.rows.filter(row => !row.isLocked && !row.final.trim() && !!row.source.trim())
    .slice(0, Math.min(AI_BATCH_LIMIT, limit));
}
export function batchTranslationPrompt(project: MoriProject, rows: MoriRow[]): string {
  if (!rows.length || rows.length > AI_BATCH_LIMIT) throw Error("Choose 1–8 untranslated, unlocked lines.");
  if (rows.some(row => row.isLocked || row.final.trim() || !row.source.trim() || row.source.length > 6000)) {
    throw Error("The batch contains a protected, already translated, or unusually long line.");
  }
  const speakers = new Map(project.characters.map(character => [character.id, character]));
  const payload = rows.map(row => ({
    id: row.id,
    english: row.source,
    developerJapanese: row.legacy ?? "",
    speaker: row.characterId ? speakers.get(row.characterId) ?? null : null,
    translatorNote: row.note ?? "",
  }));
  const terms = project.glossary
    .filter(term => term.en && rows.some(row => row.source.toLowerCase().includes(term.en.toLowerCase())))
    .map(term => ({english:term.en,japanese:term.jp,note:term.explanation})).slice(0, 60);
  return [
    "Translate these game localization lines from English to Japanese. You are an assistant to a human game translator.",
    "Respect the character's personality, tone, register and the game's glossary. Preserve all tokens/placeholders, line breaks and game-specific markup.",
    "Do not overwrite or modify existing curated text. Return proposals only.",
    "Output STRICT JSON and no prose or markdown, matching:",
    '{"translations":[{"id":"the exact string ID","japanese":"natural Japanese translation"}]}',
    "Return exactly one proposal per requested ID. Never invent other IDs.",
    "Global translation rules:", project.context.global.slice(0, 3500),
    "Project context:", project.context.project.slice(0, 5500),
    "Game terminology:", JSON.stringify(terms),
    "Lines:", JSON.stringify(payload),
  ].join("\n\n");
}

export interface BatchTranslation {
  id: string;
  japanese: string;
}
export function parseBatchReply(reply: string, expectedIds: readonly string[]): BatchTranslation[] {
  if (!expectedIds.length || expectedIds.length > AI_BATCH_LIMIT) throw Error("No valid pending batch.");
  const trimmed = reply.trim();
  // ChatGPT may wrap requested structured data in a fenced JSON block.
  const fenced = /^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i.exec(trimmed)?.[1];
  let value: unknown;
  try { value = JSON.parse(fenced ?? trimmed); }
  catch { throw Error("The assistant did not return parseable JSON; review the response in ChatGPT before retrying."); }
  const translations = value && typeof value === "object" && "translations" in value
    ? (value as { translations: unknown }).translations : null;
  if (!Array.isArray(translations) || translations.length !== expectedIds.length) {
    throw Error("AI answer is missing one or more requested translations. No changes applied.");
  }
  const allowed = new Set(expectedIds);
  const seen = new Set<string>();
  const results: BatchTranslation[] = [];
  for (const entry of translations) {
    if (!entry || typeof entry !== "object" || !("id" in entry) || !("japanese" in entry) ||
        typeof entry.id !== "string" || typeof entry.japanese !== "string" ||
        !allowed.has(entry.id) || seen.has(entry.id) || !entry.japanese.trim() ||
        entry.japanese.length > 20_000) {
      throw Error("AI answer contains an unexpected ID, duplicate, blank translation or excessive text. No changes applied.");
    }
    seen.add(entry.id);
    results.push({ id: entry.id, japanese: entry.japanese });
  }
  return results;
}
