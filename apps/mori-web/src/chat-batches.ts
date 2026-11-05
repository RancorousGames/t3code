import instructions from "../prompts/AI_TRANSLATOR.md?raw";
import { AI_BATCH_LIMIT, canDraft, parseBatchReply, withAIDraft } from "./ai-batch.ts";
import { glossaryHits } from "./insights.ts";
import type { MoriProject, MoriRow } from "./model.ts";
import { projectForTranslation, type MoriPrefs } from "./prefs.ts";

const MAX_MESSAGE = 24_000;
export const CHAT_BATCH_SIZE = 5;

type InstructionSnapshot = { contract: string; project: string };
const CONTEXT_PREFIX = "mori.batch.instructions.v1:";
const instructionKey = (projectId: string, sessionId: string, conversationId: string) =>
  `${CONTEXT_PREFIX}${projectId}:${sessionId}:${conversationId}`;

export function readChatBatchInstructions(projectId: string, sessionId: string, conversationId: string | null): InstructionSnapshot | null {
  if (!conversationId) return null;
  try {
    const data: unknown = JSON.parse(localStorage.getItem(instructionKey(projectId, sessionId, conversationId)) ?? "null");
    if (!data || typeof data !== "object" || !("contract" in data) || !("project" in data)) return null;
    return typeof data.contract === "string" && typeof data.project === "string"
      ? { contract: data.contract, project: data.project } : null;
  } catch { return null; }
}

export function markChatBatchInstructions(request: ChatBatchRequest, conversationId: string) {
  const contract = request.files.find(file => file.name === "INSTRUCTIONS.md")?.content;
  const project = request.files.find(file => file.name === "PROJECT_CONTEXT.md")?.content;
  if (contract === undefined || project === undefined) return;
  localStorage.setItem(instructionKey(request.projectId, request.sessionId, conversationId),
    JSON.stringify({ contract, project }));
}

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

export function chooseChatBatch(project: MoriProject, count = CHAT_BATCH_SIZE, focusRowId?: string | null): MoriRow[] {
  // Prioritize the line selected in Matrix, followed by nearby eligible lines.
  // No row is reordered or modified in the project itself.
  const eligible = (row: MoriRow) => canDraft(row) && !row.ai?.trim();
  const limit = Math.min(AI_BATCH_LIMIT, count);
  const index = project.rows.findIndex(row => row.id === focusRowId && eligible(row));
  if (index < 0) return project.rows.filter(eligible).slice(0, limit);
  return [
    project.rows[index]!,
    ...[...project.rows.slice(index + 1), ...project.rows.slice(0, index)]
      .filter(eligible).slice(0, Math.max(0, limit - 1)),
  ];
}

/** Immutable batch payload. Terms/characters are included only if enabled.
 * Prompt content and the on-disk audit files always match byte-for-byte. */
export function makeChatBatch(
  project: MoriProject,
  prefs: MoriPrefs,
  rows: MoriRow[],
  sessionId: string,
  requestId: string,
  previouslySent: InstructionSnapshot | null = null,
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
  // A local session can navigate to another conversation. The caller supplies a
  // baseline only for the current, confirmed ChatGPT conversation identity.
  const contract = files.find(file => file.name === "INSTRUCTIONS.md")!.content;
  const projectContext = files.find(file => file.name === "PROJECT_CONTEXT.md")!.content;
  const firstUse = !previouslySent;
  const changedContract = firstUse || previouslySent.contract !== contract;
  const changedProject = firstUse || previouslySent.project !== projectContext;
  const inline = files.filter(file =>
    file.name !== "INSTRUCTIONS.md" && file.name !== "PROJECT_CONTEXT.md");
  const message = [
    `MONKU_TRANSLATION_BATCH_ID: ${requestId}`,
    firstUse
      ? "Translate this batch. Follow the translator rules and project context provided below. Return the specified JSON only."
      : "Translate this batch using the translator rules and project context already established in this conversation. Return JSON only.",
    ...(changedContract ? [
      firstUse ? "Translator instructions:" : "Translator instructions changed to:",
      `<<<BEGIN FILE: INSTRUCTIONS.md>>>\n${contract}\n<<<END FILE: INSTRUCTIONS.md>>>`,
    ] : []),
    ...(changedProject ? [
      firstUse ? "Project instructions and context:" : "Project instructions changed to:",
      `<<<BEGIN FILE: PROJECT_CONTEXT.md>>>\n${projectContext}\n<<<END FILE: PROJECT_CONTEXT.md>>>`,
    ] : []),
    ...inline.map(file => `<<<BEGIN FILE: ${file.name}>>>\n${file.content}\n<<<END FILE: ${file.name}>>>`),
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
  return parseBatchReply(reply, request.ids);
}

/** Validate the full batch before applying any proposal. This returns one atomic
 * project update; already-saved identical results are safe to replay after a crash. */
export function mergeChatBatchDrafts(
  project: MoriProject,
  request: ChatBatchRequest,
  proposals: readonly { id: string; japanese: string }[],
): { project: MoriProject; added: number } {
  if (project.id !== request.projectId || proposals.length !== request.ids.length ||
      new Set(proposals.map(p => p.id)).size !== proposals.length ||
      proposals.some(p => !request.ids.includes(p.id) || !p.japanese.trim())) {
    throw Error("Batch does not match this project. No drafts changed.");
  }
  const translations = new Map(proposals.map(p => [p.id, p.japanese]));
  let added = 0;
  for (const id of request.ids) {
    const row = project.rows.find(item => item.id === id);
    if (!row || !canDraft(row) || row.source !== request.sources[id]) {
      throw Error("A source line changed or became protected. No drafts changed.");
    }
    const next = translations.get(id);
    if (!next) throw Error("A proposal is missing. No drafts changed.");
    if (row.ai?.trim() && row.ai !== next) {
      throw Error("A line already has a different AI draft. No drafts changed.");
    }
    if (row.ai !== next) added++;
  }
  if (!added) return { project, added: 0 };
  return {
    project: {
      ...project,
      rows: project.rows.map(row => {
        const text = translations.get(row.id);
        return text && row.ai !== text ? withAIDraft(row, text) : row;
      }),
    },
    added,
  };
}
