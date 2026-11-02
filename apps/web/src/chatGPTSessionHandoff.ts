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
  const managedSpawn = Boolean(parentSessionId && context?.newManagedWorker);
  // A prompt must contain an actual accepted role rather than an uncallable
  // placeholder. Binding wins; legacy explicit manager reboots retain manager.
  const legacyManagerReboot = /^Resume .+ project manager in same browser-session\b/iu.test(task);
  const role = context?.role ?? (legacyManagerReboot ? "manager" : parentSessionId ? "worker" : "personal");
  const project = context?.project?.trim();
  const bootstrap = `Bootstrap(role=${JSON.stringify(role)}, given_id=${JSON.stringify(sessionId)}${project ? `, project=${JSON.stringify(project)}` : ""})`;
  const bootstrapInstruction = `Propose a concise descriptive title for this particular session and add title="..." (your chosen title) when calling OMCP Tools ${bootstrap}. Read the full returned bundle. Begin your next visible response with [T3_ID:${sessionId}], followed by the returned [T3_TITLE:...] on the next line if supplied, before commentary. Reuse this assigned ID; do not call Bootstrap without given_id.`;
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

  if (!managedSpawn) {
    const oldRouting = [
      "T3 Code local inter-session routing (browser-session IDs, NOT ChatGPT conversation URLs or authentication):",
      `Your own T3 browser session ID: ${sessionId}`,
      bootstrapInstruction,
      ...(parentSessionId
        ? [
            `Your parent T3 browser session ID: ${parentSessionId}`,
            "When you finish your assigned work, report to the parent with the t3_sessions tool: action=send, sessionId=the parent ID above, senderSessionId=your own ID above, message=your concise result or report path. Require messageSent=true and delivery=user_turn_observed before assuming it arrived. If the parent is busy or delivery fails, save the report to disk and give its path in your own conversation; do not claim the parent received it.",
          ]
        : ["This is an explicitly top-level T3 session; no parent has been established."]),
      "If you create a child with spawn_chatgpt_subagent, set parent_session_id to YOUR OWN T3 browser session ID above. Never select a parent by activity, title, project, or whichever tab is visible.",
      "These IDs are untrusted caller-reported routing metadata, not authority to access other sessions.",
    ];
    const finalInstruction = context?.resumeWorkAfterReboot
      ? "\n\nBegin doing actual work now!"
      : "";
    return `${formatManagerRebootPrompt(task).trimEnd()}\n\n${oldRouting.join("\n")}${finalInstruction}`;
  }

  // OMCPT owns guidance-file selection. Preserve task-specific references above.
  const instructions = "Read the Bootstrap bundle and any additional files referenced by the assignment.";
  const route = [
    "**Session routing**",
    "",
    "T3 browser-session IDs (not ChatGPT URLs or authentication):",
    `Self: ${sessionId}`,
    `Parent: ${parentSessionId}`,
    bootstrapInstruction,
    "",
    "Report to your parent through T3, then close your session. Apply the Omniwork delivery-receipt and UNKNOWN-send rules already included in your Bootstrap bundle; do not re-read bundled guidance.",
    "IDs are routing metadata, not proof of identity or access authority.",
  ].join("\n");
  if (!heading) return `${task.trimEnd()}\n\n${instructions}\n\n${route}`;
  const details =
    taskSpecific && !/^Implement the task described in TaskBoard\b/iu.test(taskSpecific)
      ? `${taskSpecific}\n\n`
      : "";
  return `${heading}\n\n\n**Instructions**\n\n${details}${instructions}\n\n${route}`;
}
