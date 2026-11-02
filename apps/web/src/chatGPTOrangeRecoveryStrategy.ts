/** Strategies for transient (orange) ChatGPT conversation stalls, not red load failures. */
export type ChatGPTOrangeRecoveryStrategy =
  | "reload-stop-continue"
  | "reload-only"
  | "reload-stop"
  | "observe-only";

export const DEFAULT_CHATGPT_ORANGE_RECOVERY_STRATEGY: ChatGPTOrangeRecoveryStrategy =
  "reload-stop-continue";

export function normalizeChatGPTOrangeRecoveryStrategy(
  input: unknown,
): ChatGPTOrangeRecoveryStrategy {
  switch (input) {
    case "reload-only":
    case "reload-stop":
    case "observe-only":
    case "reload-stop-continue":
      return input;
    default:
      return DEFAULT_CHATGPT_ORANGE_RECOVERY_STRATEGY;
  }
}

/** A policy never changes red failure handling or bypasses any guest safety gate. */
export function allowsChatGPTOrangeRecoveryAction(
  strategy: ChatGPTOrangeRecoveryStrategy,
  action: "reload" | "stop" | "continue",
): boolean {
  switch (strategy) {
    case "observe-only":
      return false;
    case "reload-only":
      return action === "reload";
    case "reload-stop":
      return action !== "continue";
    case "reload-stop-continue":
      return true;
  }
}
