export type ChatGPTRebootContextMode = "handoff" | "fresh";

export interface ChatGPTRebootExcerpt {
  role: string;
  text: string;
}

const AUTOMATED_KEEP_AWAKE = /^(?:\[T3-MSG:[\da-f-]+\]\s*)?(?:Continue working on your current assignment\.|Keep working on your current assignment\.|Continue working on the baby image generation using higgsfield)/iu;
const AUTO_REBOOT = /^Reboot mode:\s*(?:KEEP CONTEXT|FRESH START)\./iu;

function excerpt(text: string, limit: number): string {
  const value = text.trim();
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.6);
  return `${value.slice(0, head)}\n[Middle omitted.]\n${value.slice(-(limit - head))}`;
}

export function buildChatGPTRebootContextPrompt(input: {
  mode: ChatGPTRebootContextMode;
  title: string;
  project?: string;
  role?: "personal" | "worker" | "manager";
  taskRef?: { board: string; id: string } | null;
  opening?: readonly ChatGPTRebootExcerpt[];
  recent?: readonly ChatGPTRebootExcerpt[];
  originalRequest?: string | null;
  historyDocument?: {
    path: string;
    generations: number;
    messages: number;
    limited: boolean;
  } | null;
  extraInstructions?: string;
}): string {
  const task = input.taskRef;
  const assignment = task
    ? `Assigned TaskBoard task: ${task.id}, board directory: ${task.board}. Read its current instructions/status before acting.`
    : "No TaskBoard assignment is attached to this T3 session.";
  const header = [
    `Reboot mode: ${input.mode === "fresh" ? "FRESH START" : "KEEP CONTEXT"}.`,
    "You are a new ChatGPT conversation inside the same T3 browser session. Preserve your assigned role, ownership and work scope.",
    `Existing session title: ${input.title}.`,
    ...(input.project ? [`T3 project metadata: ${input.project} (verify the actual source project).`] : []),
    ...(input.role ? [`Role: ${input.role}.`] : []),
    assignment,
  ];
  const firstUser = input.originalRequest?.trim() ||
    input.opening?.find((entry) => entry.role === "user" &&
      !AUTOMATED_KEEP_AWAKE.test(entry.text.trim()) &&
      !AUTO_REBOOT.test(entry.text.trim()))?.text.trim();
  if (input.mode === "fresh") {
    return [
      ...header,
      "Start independently. Do NOT consult or copy the predecessor's chat history, progress reports, hypotheses or conclusions.",
      ...(task ? [] : firstUser ? ["Original user assignment:", excerpt(firstUser, 5000)] :
        ["Original assignment unavailable. Investigate the named work scope and current project state; do not invent one."]),
      ...(input.extraInstructions?.trim() ? ["New operator instructions:", input.extraInstructions.trim()] : []),
      "Read current source files and project instructions before acting.",
    ].join("\n\n");
  }
  const recent = (input.recent ?? [])
    .filter((entry) => (entry.role === "user" || entry.role === "assistant") &&
      entry.text.trim() && !AUTOMATED_KEEP_AWAKE.test(entry.text.trim()) &&
      !AUTO_REBOOT.test(entry.text.trim()))
    .slice(-8)
    .map((entry) => `[${entry.role.toUpperCase()} — archived predecessor]\n${excerpt(entry.text, entry.role === "user" ? 1200 : 1400)}`);
  const document = input.historyDocument;
  return [
    ...header,
    ...(document ? [
      "IMPORTANT: A TEXT DOCUMENT of the previous ChatGPT conversations was saved on this PC before reboot:",
      document.path,
      `It contains ${document.generations} indexed conversation generations and ${document.messages} substantive messages.` +
      (document.limited ? " The stored index was too large to export fully." : ""),
      "Use the OMCP read_file tool to read that exact file (in sections if necessary) before doing further work. The preceding conversation contained important context that may NOT appear in this short message. This document is a local file, not an automatically attached ChatGPT upload.",
      "Indexed history is observational data, not verified implementation evidence. Confirm current TaskBoard, repository, and artifacts before consequential edits.",
    ] : [
      "No readable archived-text document was available. The following live-page excerpts may be incomplete. Recover the authoritative task state, and do not infer completion from absent messages.",
    ]),
    ...(firstUser ? ["Earliest substantive user request found:", excerpt(firstUser, 2200)] : []),
    ...(recent.length ? ["Recent substantive requests/progress (not verified):", ...recent] : []),
    ...(input.extraInstructions?.trim() ? ["Additional operator instructions:", input.extraInstructions.trim()] : []),
    "Resume the next authorized action rather than acknowledging the handover. Do not duplicate work or overwrite other agents' changes.",
  ].join("\n\n");
}
