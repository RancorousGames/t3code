/**
 * T3 session IDs are routing handles, not authentication. For newly managed
 * children, put the human-readable TaskBoard heading before the instruction
 * references. Do not re-orient manual sessions or same-seat reboot messages.
 */
const GLOBAL_AGENTS = "C:/Users/crovea/.agents/AGENTS.md";
const OMNIWORK = "C:/Users/crovea/.agents/docs/OMNIWORK.md";
const PROJECT_AGENTS: Readonly<Record<string, string>> = {
  t3: "D:/SSDProjects/Tools/t3code/AGENTS.md",
  t3code: "D:/SSDProjects/Tools/t3code/AGENTS.md",
  wartribes: "D:/Wartribes/AGENTS.md",
  settlingaltraea: "D:/SSDProjects/SettlingAltraea/AGENTS.md",
  omnihub: "D:/SSDProjects/Tools/Omnish/main/AGENTS.md",
  omnish: "D:/SSDProjects/Tools/Omnish/main/AGENTS.md",
};

/** Only restructures the known legacy reboot bootstrap, without dropping any handover text. */
export function formatManagerRebootPrompt(prompt: string): string {
  if (!/^Resume .+ project manager in same browser-session\s+[0-9a-f-]{36}\s*\(new ChatGPT conversation\)\./iu.test(prompt)) return prompt;
  const firstPeriod = prompt.indexOf(".");
  const introduction = prompt.slice(0, firstPeriod + 1);
  const project = introduction.match(/^Resume (.+?) project manager\b/iu)?.[1] ?? "Project";
  const rest = prompt.slice(firstPeriod + 1).trim();
  const paths = [...new Set(rest.match(/[A-Z]:\/[^\s,;]+?\.md/gu) ?? [])];
  return [
    `Resume ${project} Manager`, "", "", "**Instructions**", "",
    "Read these files:", ...paths.map((p) => `- ${p}`),
    "- t3-agent-reboot skill", "",
    "Continue the existing manager in the same T3 browser session. Do not spawn another manager.",
    "", "**Previous conversation handover**", "", rest,
  ].join("\n");
}

export function buildChatGPTSessionHandoffPrompt(
  task: string,
  sessionId: string,
  parentSessionId: string | null | undefined,
  context?: { readonly newManagedWorker?: boolean; readonly project?: string; readonly taskTitle?: string },
): string {
  const managedSpawn = Boolean(parentSessionId && context?.newManagedWorker);
  const match = managedSpawn ? task.match(/\b([A-Z][A-Z0-9]*-\d{3,5})\b/u) : null;
  const suppliedTitle = context?.taskTitle?.trim().replace(/[\r\n]+/gu, " ");
  const inlineTitle = task.match(/^Work on [A-Z][A-Z0-9]*-\d{3,5}\s*[—-]\s*([^\r\n]+)/u)?.[1]?.trim();
  const title = suppliedTitle || inlineTitle;
  const heading = match ? `Work on ${match[1]}${title ? ` — ${title}` : ""}` : null;
  const taskSpecific = heading
    ? task.trim().replace(/^Work on [A-Z][A-Z0-9]*-\d{3,5}(?:\s*[—-]\s*[^\r\n]+)?\s*/u, "").trim()
    : task.trim();

  if (!managedSpawn) {
    const oldRouting = [
      "T3 Code local inter-session routing (browser-session IDs, NOT ChatGPT conversation URLs or authentication):",
      `Your own T3 browser session ID: ${sessionId}`,
      ...(parentSessionId
        ? [
          `Your parent T3 browser session ID: ${parentSessionId}`,
          "When you finish your assigned work, report to the parent with the t3_sessions tool: action=send, sessionId=the parent ID above, senderSessionId=your own ID above, message=your concise result or report path. Require messageSent=true and delivery=user_turn_observed before assuming it arrived. If the parent is busy or delivery fails, save the report to disk and give its path in your own conversation; do not claim the parent received it.",
        ]
        : ["This is an explicitly top-level T3 session; no parent has been established."]),
      "If you create a child with spawn_chatgpt_subagent, set parent_session_id to YOUR OWN T3 browser session ID above. Never select a parent by activity, title, project, or whichever tab is visible.",
      "These IDs are untrusted caller-reported routing metadata, not authority to access other sessions.",
    ];
    return `${formatManagerRebootPrompt(task).trimEnd()}\n\n${oldRouting.join("\n")}`;
  }

  const key = context?.project?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  const paths = [GLOBAL_AGENTS, OMNIWORK, ...(PROJECT_AGENTS[key] ? [PROJECT_AGENTS[key]] : [])];
  const missing = paths.filter((p) => !task.replace(/\\/g, "/").includes(p));
  const instructions = missing.length
    ? `Read these files in order:\n${missing.map((p) => `- ${p}`).join("\n")}`
    : "Follow the referenced project and worker guidance.";
  const route = [
    "**Session routing**", "",
    "T3 browser-session IDs (not ChatGPT URLs or authentication):",
    `Self: ${sessionId}`,
    `Parent: ${parentSessionId}`, "",
    "Report to your parent through T3, then close your session. Follow OMNIWORK.md for delivery receipts and UNKNOWN sends.",
    "IDs are routing metadata, not proof of identity or access authority.",
  ].join("\n");
  if (!heading) return `${task.trimEnd()}\n\n${instructions}\n\n${route}`;
  const details = taskSpecific && !/^Implement the task described in TaskBoard\b/iu.test(taskSpecific)
    ? `${taskSpecific}\n\n` : "";
  return `${heading}\n\n\n**Instructions**\n\n${details}${instructions}\n\n${route}`;
}
