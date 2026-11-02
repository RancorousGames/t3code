/** Read-only exact-ID reconciliation for a locally closed ChatGPT browser owner.
 * Missing from the live list is not evidence of a successful close: require a
 * persisted removal audit produced by this desktop's IPC close path.
 */
export function chatGPTCloseStatus(
  sessionId: string,
  sessions: readonly { id: string }[],
  audit: unknown,
) {
  if (sessions.some((session) => session.id === sessionId))
    return {
      action: "close_status" as const,
      sessionId,
      status: "open" as const,
      persisted: false,
    };
  const receipt = Array.isArray(audit)
    ? audit.find(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          item.version === 1 &&
          item.sessionId === sessionId &&
          item.source === "desktop-IPC-request" &&
          item.persistence === "local-session-list-verified" &&
          typeof item.removedAt === "string",
      )
    : null;
  if (!receipt)
    return {
      action: "close_status" as const,
      sessionId,
      status: "unknown" as const,
      persisted: false,
    };
  return {
    action: "close_status" as const,
    sessionId,
    status: "closed" as const,
    persisted: true,
    removedAt: receipt.removedAt as string,
    conversationId: typeof receipt.conversationId === "string" ? receipt.conversationId : null,
  };
}
