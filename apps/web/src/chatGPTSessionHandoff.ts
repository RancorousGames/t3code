/**
 * Spawned ChatGPT guests cannot inspect their host T3 tab ID. Supply that
 * ID when the host creates the initial prompt, after the tab has been persisted.
 * These are routing handles, never proof of a sender's identity or permission.
 */
export function buildChatGPTSessionHandoffPrompt(
  task: string,
  sessionId: string,
  parentSessionId: string | null | undefined,
): string {
  const routing = [
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
  return `${task.trimEnd()}\n\n${routing.join("\n")}`;
}
