import { describe, expect, it } from "vite-plus/test";
import { chatGPTAssistantAdvanced, chatGPTAssistantSignature } from "./chatGPTRecoveryProgress";

describe("ChatGPT recovery progress", () => {
  it("does not treat a Stop/working indicator or unchanged assistant text as recovery", () => {
    expect(
      chatGPTAssistantAdvanced(
        {
          lastRole: "user",
          lastText: "",
          assistantHasContent: false,
        },
        0,
      ),
    ).toBe(false);
    const stalled = {
      lastRole: "assistant" as const,
      assistantHasContent: true,
      lastText: "same partial reply",
    };
    expect(chatGPTAssistantAdvanced(stalled, chatGPTAssistantSignature(stalled))).toBe(false);
    expect(chatGPTAssistantAdvanced(stalled, null)).toBe(false);
    expect(
      chatGPTAssistantAdvanced(
        { ...stalled, lastText: "same partial reply advanced" },
        chatGPTAssistantSignature(stalled),
      ),
    ).toBe(true);
  });
});
