import instructions from "../prompts/AI_TRANSLATOR.md?raw";
import { AI_BATCH_LIMIT, canDraft, parseBatchReply } from "./ai-batch.ts";
import { glossaryHits } from "./insights.ts";
import type { MoriProject, MoriRow } from "./model.ts";
import { projectForTranslation, type MoriPrefs } from "./prefs.ts";

const MAX_MESSAGE = 24_000;
export const CHAT_BATCH_SIZE = 3;

/** An app-owned materialized file. This is sent INLINE to ChatGPT as well as
 * snapshotted on disk; ChatGPT cannot access an absolute local path. */
export interface ChatBatchFile {
  name: "INSTRUCTIONS.md" | "PROJECT_CONTEXT.md" | "CHARACTERS.md" |
    "GLOSSARY.md" | "BATCH_REQUEST.json";
  content: string;
}

export interface ChatBatchRequest {
  requestId: string;
  projectId: string;
  sessionId: string;
  ids: string[];
  sources: Record<string, string>;
  message: string;
  files: ChatBatchFile[];
  createdAt: number;
}

const bounded = (value: string, limit: number, label: string) => {
  if (value.length > limit) throw Error(`${label} exceeds ${limit} characters. Shorten the source context before sending.`);
  return value;
};

function charactersFile(project: MoriProject, rows: MoriRow[]): string | null {
  const ids = new Set(rows.map(row => row.characterId).filter(Boolean));
  const used = project.characters.filter(c => ids.has(c.id));
  if (!used.length) return null;
  return "# Character voice and register\n\n" + used.map(c =>
    `## ${c.name} (${c.id})\n\nRole: ${c.role}\nTone: ${c.tone}\nVoice notes: ${c.description}`,
  ).join("\n\n");
}

function glossaryFile(project: MoriProject, rows: MoriRow[]): string | null {
  const used = new Set(rows.flatMap(row => glossaryHits(row.source, project.glossary)));
  const relevant = project.glossary.filter(term => used.has(term));
  if (!relevant.length) return null;
  return "# Canonical glossary for this batch\n\n" + relevant.map(t =>
    `- **${t.en}** → **${t.jp}**${t.explanation ? ` — ${t.explanation}` : ""}`,
  ).join("\n");
}

export function chooseChatBatch(project: MoriProject, count = CHAT_BATCH_SIZE): MoriRow[] {
  return project.rows.filter(canDraft).slice(0, Math.min(AI_BATCH_LIMIT, count));
}

/** Immutable batch payload. Terms/characters are included only if enabled.
 * Prompt content and the on-disk audit files always match byte-for-byte. */
export function makeChatBatch(
  project: MoriProject,
  prefs: MoriPrefs,
  rows: MoriRow[],
  sessionId: string,
  requestId: string,
): ChatBatchRequest {
  if (!rows.length || rows.length > AI_BATCH_LIMIT || rows.some(row => !canDraft(row))) {
    throw Error(`Choose 1–${AI_BATCH_LIMIT} unlocked, untranslated English lines.`);
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error("Batch IDs must be unique.");
  const reference = projectForTranslation(project, prefs);
  const files: ChatBatchFile[] = [
    { name: "INSTRUCTIONS.md", content: instructions.trim() },
    { name: "PROJECT_CONTEXT.md", content: [
      "# Project translation context",
      `Project: ${project.name}`,
      "## Global translation conventions",
      bounded(reference.context.global, 4500, "Global conventions") || "(none supplied)",
      "## Game setting, narrative, style and context",
      bounded(reference.context.project, 6500, "Game context") || "(none supplied)",
    ].join("\n\n") },
  ];
  const chars = charactersFile(reference, rows);
  if (chars) files.push({ name: "CHARACTERS.md", content: chars });
  const terms = glossaryFile(reference, rows);
  if (terms) files.push({ name: "GLOSSARY.md", content: terms });
  const payload = {
    requestId,
    projectId: project.id,
    lines: rows.map(row => ({
      id: row.id,
      english: row.source,
      developerJapanese: row.legacy ?? "",
      translatorNote: row.note ?? "",
      speakerId: prefs.charactersEnabled ? row.characterId ?? null : null,
    })),
  };
  files.push({ name: "BATCH_REQUEST.json", content: JSON.stringify(payload, null, 2) });
  const message = [
    `MONKU_TRANSLATION_BATCH_ID: ${requestId}`,
    "Translate this batch. The following virtual files contain their FULL CONTENTS. They are supplied inline,",
    "not by local filesystem paths; follow INSTRUCTIONS.md and return the specified JSON only.",
    ...files.map(file => `<<<BEGIN FILE: ${file.name}>>>\n${file.content}\n<<<END FILE: ${file.name}>>>`),
  ].join("\n\n");
  if (message.length > MAX_MESSAGE) {
    throw Error(`Translation task is ${message.length} characters (maximum ${MAX_MESSAGE}). Shorten project context or reduce batch size.`);
  }
  return {
    requestId, projectId: project.id, sessionId,
    ids: rows.map(row => row.id),
    sources: Object.fromEntries(rows.map(row => [row.id, row.source])),
    message, files, createdAt: Date.now(),
  };
}

export function parseChatBatchAnswer(reply: string, request: ChatBatchRequest) {
  const proposals = parseBatchReply(reply, request.ids);
  // Existing project source may have changed while ChatGPT was working; caller
  // also compares each row's current source and lock status before acceptance.
  return proposals;
}
