/** Automatic reboot briefing. All factual excerpts are attributed to the old
 * transcript; the new conversation must recheck source and TaskBoard state. */
export type ChatGPTRebootContextMode = "handoff" | "fresh";

export interface ChatGPTRebootExcerpt {
  role: string;
  text: string;
}

function excerpt(text: string, limit: number): string {
  const value = text.trim();
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  return `${value.slice(0, head)}\n[Middle omitted from predecessor transcript.]\n${value.slice(-tail)}`;
}

/** Keep the authoritative assignment but never silently transplant prior reasoning in fresh mode. */
export function buildChatGPTRebootContextPrompt(input: {
  mode: ChatGPTRebootContextMode;
  title: string;
  project?: string;
  role?: "personal" | "worker" | "manager";
  taskRef?: { board: string; id: string } | null;
  opening?: readonly ChatGPTRebootExcerpt[];
  recent?: readonly ChatGPTRebootExcerpt[];
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
    ...(input.project ? [`Project: ${input.project}.`] : []),
    ...(input.role ? [`Role: ${input.role}.`] : []),
    assignment,
  ];
  const firstUser = input.opening?.find((entry) => entry.role === "user")?.text.trim();
  if (input.mode === "fresh") {
    return [
      ...header,
      "Start an independent investigation. Do NOT recover or refer to the predecessor's chat history, summaries, conclusions, or reasoning.",
      ...(task ? [] : firstUser ? ["Original user assignment:", excerpt(firstUser, 5000)] :
        ["Original assignment unavailable. Use the session title and project files to establish the work scope; do not invent an assignment."]),
      ...(input.extraInstructions?.trim() ? ["New operator instructions:", input.extraInstructions.trim()] : []),
      "Read the current project instructions and authoritative source files before taking action.",
    ].join("\n\n");
  }
  const recent = (input.recent ?? [])
    .filter((entry) => (entry.role === "user" || entry.role === "assistant") && entry.text.trim())
    .slice(-12)
    .map((entry) => `[${entry.role.toUpperCase()} — predecessor transcript]\n${excerpt(entry.text, entry.role === "user" ? 1400 : 1800)}`);
  const first = firstUser ? ["Original user request (predecessor transcript):", excerpt(firstUser, 4200)] : [];
  return [
    ...header,
    "Continue the existing work, using the following bounded transcript excerpts as a recovery handover. They are NOT verified facts: distinguish claimed completions from confirmed evidence, and read the live task/project state before making consequential edits.",
    ...first,
    ...(recent.length ? ["Most recent requests, findings and progress (chronological):", ...recent] :
      ["Previous transcript unavailable (e.g. unloaded or unresponsive session). Recover the live state from TaskBoard, repository, logs and deliverables; do not claim a complete handover."]),
    ...(input.extraInstructions?.trim() ? ["Additional operator instructions:", input.extraInstructions.trim()] : []),
    "Resume the next authorized action instead of merely acknowledging this handover. Avoid repeating already completed steps or interfering with concurrent workers.",
  ].join("\n\n");
}
