import { describe, expect, it } from "vite-plus/test";
import { resolveChatGPTSessionAddress } from "./chatGPTConversationRouting";
import type { BrowserSession } from "./chatGPTBrowserSessions";

const CONVERSATION = "6ada88be-7e48-83eb-a735-75dbd1161d46";
const TAB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sessions: BrowserSession[] = [{ id: TAB, title: "Worker" }];

describe("ChatGPT ID resolution for read/send", () => {
  it("preserves exact T3 browser session IDs, even if they look like conversation IDs", () => {
    expect(resolveChatGPTSessionAddress(TAB, sessions, () => null)).toEqual({
      sessionId: TAB, conversationId: null, create: false,
    });
  });
  it("reuses the unique available session referencing a conversation", () => {
    expect(resolveChatGPTSessionAddress(CONVERSATION, sessions, () => `https://chatgpt.com/c/${CONVERSATION}`))
      .toEqual({ sessionId: TAB, conversationId: CONVERSATION, create: false });
  });
  it("opens the requested ChatGPT conversation if it isn't already loaded", () => {
    expect(resolveChatGPTSessionAddress(CONVERSATION, sessions, () => null))
      .toEqual({ sessionId: null, conversationId: CONVERSATION, create: true });
  });
  it("does not mistake a missing T3 UUIDv4 for a ChatGPT conversation", () => {
    const missingTab = "8844dff8-f152-4f3c-8d4f-f0d6c6997c9a";
    expect(() => resolveChatGPTSessionAddress(missingTab, sessions, () => null))
      .toThrow(/Unknown T3-style session UUID/);
    // Older real ChatGPT conversations may also use UUIDv4; explicit intent still works.
    expect(resolveChatGPTSessionAddress(missingTab, sessions, () => null, missingTab))
      .toEqual({ sessionId: null, conversationId: missingTab, create: true });
  });
  it("does not route to hidden/archived sessions", () => {
    expect(resolveChatGPTSessionAddress(CONVERSATION, [{ ...sessions[0]!, hidden: true }], () =>
      `https://chatgpt.com/c/${CONVERSATION}`)).toMatchObject({ create: true });
  });
  it("refuses ambiguous matches and mismatched guards", () => {
    expect(() => resolveChatGPTSessionAddress(CONVERSATION,
      [...sessions, { id: other, title: "Duplicate" }], () => `https://chatgpt.com/c/${CONVERSATION}`))
      .toThrow(/Several live/);
    expect(() => resolveChatGPTSessionAddress(CONVERSATION, [], () => null, other))
      .toThrow(/disagree/);
    expect(() => resolveChatGPTSessionAddress("not-a-uuid", [], () => null))
      .toThrow(/canonical/);
  });
});
