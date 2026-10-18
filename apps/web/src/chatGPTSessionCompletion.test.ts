import { describe, expect, it } from "vite-plus/test";

import { validChatGPTCompletion } from "./chatGPTSessionCompletion";

const declared = {
  declaredAt: "2026-10-18T13:45:00.000Z",
  observedTurns: 4,
  observedUrl: "https://chatgpt.com/c/my-conversation",
};

describe("ChatGPT completion lifecycle within a stable T3 tab", () => {
  it("accepts the declared conversation after reload, a URL query change or domain migration", () => {
    expect(validChatGPTCompletion(declared, declared.observedUrl, 4, true)).toEqual(declared);
    expect(
      validChatGPTCompletion(
        declared,
        "https://chatgpt.com/c/my-conversation?mode=public",
        4,
        true,
      ),
    ).toEqual(declared);
    expect(
      validChatGPTCompletion(declared, "https://chat.openai.com/c/my-conversation", 4, true),
    ).toEqual(declared);
  });

  it("never confuses a navigated browser tab with the completed conversation", () => {
    expect(validChatGPTCompletion(declared, "https://chatgpt.com/c/other", 4, true)).toBeNull();
    expect(validChatGPTCompletion(declared, "https://docs.example.com/", 4, true)).toBeNull();
    expect(validChatGPTCompletion(declared, "https://chatgpt.com/", 4, true)).toBeNull();
  });

  it("does not report completion while generating, unreadable, or after user activity changes", () => {
    expect(validChatGPTCompletion(declared, declared.observedUrl, 4, false)).toBeNull();
    expect(validChatGPTCompletion(declared, declared.observedUrl, 5, true)).toBeNull();
    expect(validChatGPTCompletion(declared, declared.observedUrl, 3, true)).toBeNull();
    expect(validChatGPTCompletion(undefined, declared.observedUrl, 4, true)).toBeNull();
  });
});
