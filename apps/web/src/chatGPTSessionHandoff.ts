/**
 * T3 session IDs are routing handles, not authentication. For newly managed
 * children, put the human-readable TaskBoard heading before the instruction
 * references. Only existing automatic spawn/reboot messages use this formatter;
 * manual conversations never receive an automatic bootstrap message.
 */

/** Only restructures the known legacy reboot bootstrap, without dropping any handover text. */
export function formatManagerRebootPrompt(prompt: string): string {
  if (
    !/^Resume .+ project manager in same browser-session\s+[0-9a-f-]{36}\s*\(new ChatGPT conversation\)\./iu.test(
      prompt,
    )
  )
    return prompt;
  const firstPeriod = prompt.indexOf(".");
  const introduction = prompt.slice(0, firstPeriod + 1);
  const project = introduction.match(/^Resume (.+?) project manager\b/iu)?.[1] ?? "Project";
  const rest = prompt.slice(firstPeriod + 1).trim();
  const paths = [...new Set(rest.match(/[A-Z]:\/[^\s,;]+?\.md/gu) ?? [])];
  return [
    `Resume ${project} Manager`,
    "",
    "",
    "**Instructions**",
    "",
    "Read these files:",
    ...paths.map((p) => `- ${p}`),
    "- t3-agent-reboot skill",
    "",
    "Continue the existing manager in the same T3 browser session. Do not spawn another manager.",
    "",
    "**Previous conversation handover**",
    "",
    rest,
  ].join("\n");
}

export function buildChatGPTSessionHandoffPrompt(
  task: string,
  sessionId: string,
  parentSessionId: string | null | undefined,
  context?: {
    readonly newManagedWorker?: boolean;
    readonly project?: string;
    readonly role?: "personal" | "worker" | "manager";
    readonly taskTitle?: string;
    readonly resumeWorkAfterReboot?: boolean;
  },
): string {
  const managedSpawn = context?.newManagedWorker === true;
  // A prompt must contain an actual accepted role rather than an uncallable
  // placeholder. Binding wins; legacy explicit manager reboots retain manager.
  const legacyManagerReboot = /^Resume .+ project manager in same browser-session\b/iu.test(task);
  const role = context?.role ?? (legacyManagerReboot ? "manager" : parentSessionId ? "worker" : "personal");
  const project = context?.project?.trim();
  const bootstrap = `Bootstrap(role=${JSON.stringify(role)}, given_id=${JSON.stringify(sessionId)}${project ? `, project=${JSON.stringify(project)}` : ""})`;
  // Bootstrap already supplies the full policy, routing ID and any title. For
  // new sessions keep the visible ID marker as a fallback if tool-result
  // registration is unavailable; rebooted sessions can use the tool receipt.
  const bootstrapInstruction = [
    `Call OMCP Tools ${bootstrap} exactly once, without a title argument.`,
    "Read and follow its returned instructions.",
    managedSpawn
      ? `Print [T3_ID:${sessionId}] in your first response for new-session registration; do not print T3_TITLE.`
      : "This is a reboot of an already named session. Do not print T3_ID or T3_TITLE; the Bootstrap tool result provides the registration receipt.",
  ].join("\n");
  const match = managedSpawn ? task.match(/\b([A-Z][A-Z0-9]*-\d{3,5})\b/u) : null;
  const suppliedTitle = context?.taskTitle?.trim().replace(/[\r\n]+/gu, " ");
  const inlineTitle = task
    .match(/^Work on [A-Z][A-Z0-9]*-\d{3,5}\s*[—-]\s*([^\r\n]+)/u)?.[1]
    ?.trim();
  const title = suppliedTitle || inlineTitle;
  const heading = match ? `Work on ${match[1]}${title ? ` — ${title}` : ""}` : null;
  const taskSpecific = heading
    ? task
        .trim()
        .replace(/^Work on [A-Z][A-Z0-9]*-\d{3,5}(?:\s*[—-]\s*[^\r\n]+)?\s*/u, "")
        .trim()
    : task.trim();

  // Parent identity is the one datum Bootstrap cannot infer from its
  // role/given_id/project arguments. Delivery and delegation rules are in the
  // Bootstrap bundle, so don't duplicate them in every handoff.
  const parent = parentSessionId ? `\nParent T3 session ID: ${parentSessionId}.` : "";
  const finalInstruction = context?.resumeWorkAfterReboot ? "\n\nBegin doing actual work now!" : "";
  if (!managedSpawn)
    return `${formatManagerRebootPrompt(task).trimEnd()}\n\n${bootstrapInstruction}${parent}${finalInstruction}`;

  const details =
    taskSpecific && !/^Implement the task described in TaskBoard\b/iu.test(taskSpecific)
      ? `${taskSpecific}\n\n`
      : "";
  if (!heading) return `${task.trimEnd()}\n\n${bootstrapInstruction}${parent}`;
  return `${heading}\n\n\n**Instructions**\n\n${details}${bootstrapInstruction}${parent}`;
}
