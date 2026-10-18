import { describe, expect, it } from "vite-plus/test";

import {
  chatGPTConversationIdFromUrl,
  requireExpectedChatGPTConversation,
} from "./chatGPTConversationIdentity";
import { isChatGPTConversationUrl } from "./chatGPTBrowserSessions";

describe("ChatGPT conversation URL discovery", () => {
  it("extracts the observed conversation path separately from its T3 browser UUID", () => {
    expect(chatGPTConversationIdFromUrl("https://chatgpt.com/c/ABC-123?mode=chat")).toBe("abc-123");
    expect(chatGPTConversationIdFromUrl("https://chatgpt.com/g/g-custom/c/ABC-123")).toBe(
      "abc-123",
    );
    expect(chatGPTConversationIdFromUrl("https://chat.openai.com/c/abc-123")).toBe("abc-123");
    expect(isChatGPTConversationUrl("https://chatgpt.com/c/abc-123")).toBe(true);
  });

  it("requires an exact canonical UUID and current guest ChatGPT URL for routing", () => {
    const id = "6ad4addb-8fc0-83eb-832c-47b147adffb2";
    expect(requireExpectedChatGPTConversation(id, `https://chatgpt.com/c/${id}?query=1`)).toBe(id);
    expect(requireExpectedChatGPTConversation(id, `https://chat.openai.com/c/${id}`)).toBe(id);
    for (const url of [
      `https://chatgpt.com/c/${id.slice(0, -1)}3`,
      `https://example.com/c/${id}`,
      "https://chatgpt.com/",
      "",
      null,
    ]) {
      expect(() => requireExpectedChatGPTConversation(id, url)).toThrow(/guard mismatch/);
    }
    for (const invalid of ["", "  ", "ABC", id.toUpperCase(), "https://chatgpt.com/c/" + id]) {
      expect(() =>
        requireExpectedChatGPTConversation(invalid, `https://chatgpt.com/c/${id}`),
      ).toThrow(/canonical lowercase/);
    }
  });

  it("returns no conversation identity for a new chat, other site, or malformed path", () => {
    for (const url of [
      "https://chatgpt.com/",
      "https://chatgpt.com/g/g-custom",
      "https://example.com/c/abc-123",
      "http://chatgpt.com/c/abc-123",
      "https://notchatgpt.com/c/abc-123",
      "https://chatgpt.com/c/",
      "https://chatgpt.com/c/abc-123!invalid",
      null,
    ]) {
      expect(chatGPTConversationIdFromUrl(url)).toBeNull();
    }
  });
});
