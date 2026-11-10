/** Only real new assistant content verifies progress of a stalled ChatGPT turn. */
export interface ChatGPTAssistantProgressSnapshot {
  lastRole?: "user" | "assistant" | null;
  lastText?: string;
  assistantHasContent?: boolean;
}

export function chatGPTAssistantSignature(snapshot: ChatGPTAssistantProgressSnapshot): number {
  let hash = 2166136261;
  for (const char of snapshot.lastRole === "assistant" ? (snapshot.lastText ?? "") : "")
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function chatGPTAssistantAdvanced(
  snapshot: ChatGPTAssistantProgressSnapshot,
  initialSignature: number | null | undefined,
): boolean {
  return (
    snapshot.lastRole === "assistant" &&
    snapshot.assistantHasContent === true &&
    typeof initialSignature === "number" &&
    chatGPTAssistantSignature(snapshot) !== initialSignature
  );
}
