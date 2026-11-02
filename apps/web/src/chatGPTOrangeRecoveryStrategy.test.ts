import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_CHATGPT_ORANGE_RECOVERY_STRATEGY,
  allowsChatGPTOrangeRecoveryAction,
  normalizeChatGPTOrangeRecoveryStrategy,
  type ChatGPTOrangeRecoveryStrategy,
} from "./chatGPTOrangeRecoveryStrategy";

describe("orange recovery strategy policy", () => {
  it("preserves existing full recovery for missing or invalid settings", () => {
    expect(normalizeChatGPTOrangeRecoveryStrategy(undefined)).toBe(
      DEFAULT_CHATGPT_ORANGE_RECOVERY_STRATEGY,
    );
    expect(normalizeChatGPTOrangeRecoveryStrategy("unsafe-retry")).toBe("reload-stop-continue");
  });

  it.each([
    ["reload-stop-continue", [true, true, true]],
    ["reload-only", [true, false, false]],
    ["reload-stop", [true, true, false]],
    ["observe-only", [false, false, false]],
  ] as const)("gates reload/stop/continue for %s", (strategy, expected) => {
    expect(normalizeChatGPTOrangeRecoveryStrategy(strategy)).toBe(strategy);
    const actions = ["reload", "stop", "continue"] as const;
    expect(
      actions.map((action) =>
        allowsChatGPTOrangeRecoveryAction(strategy as ChatGPTOrangeRecoveryStrategy, action),
      ),
    ).toEqual(expected);
  });
});
