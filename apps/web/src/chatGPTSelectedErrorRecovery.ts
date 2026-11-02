/** Selected-session recovery is a user-driven exception to background pause.
 * Never infer failure from an unloaded, unmounted, loading, orange or working guest. */
export function isSelectedChatGPTError(value: {
  uiColor: string;
  status: string;
  recoveryProblem?: string | null;
  activity?: string;
  conversationFull?: boolean;
}): boolean {
  if (value.conversationFull || value.activity === "working") return false;
  if (["hidden", "hibernated", "loading", "settings", "conversation_full"].includes(value.status))
    return false;
  return value.uiColor === "invalid" ||
    value.status === "stuck" ||
    value.recoveryProblem === "browser-unresponsive";
}
