import { describe, expect, it } from "vite-plus/test";
import { resolveWarmChatGPTConversationUrl } from "./chatGPTWarmConversationUrl";
import type { BrowserSession } from "../chatGPTBrowserSessions";

const id = "6ae291a4-e110-83eb-ad4d-dec6dfe17cb7";
const url = `https://chatgpt.com/c/${id}`;
const session = (fields: Partial<BrowserSession> = {}): BrowserSession => ({
  id: "a4109318-ee49-4963-a8e4-9f98eb634624",
  title: "Worker",
  ...fields,
});

describe("warm conversation restoration", () => {
  it("uses the saved URL first and recovers only known conversation ownership", () => {
    expect(resolveWarmChatGPTConversationUrl(session(), url)).toBe(url);
    expect(resolveWarmChatGPTConversationUrl(session(), null, url)).toBe(url);
    expect(
      resolveWarmChatGPTConversationUrl(
        session({
          bootstrapIdentity: { state: "registered", conversationId: id },
        }),
        null,
      ),
    ).toBe(url);
    expect(
      resolveWarmChatGPTConversationUrl(
        session({
          archive: { archivedAt: "2026-10-29", conversationUrl: url, basis: "completion" },
        }),
        null,
      ),
    ).toBe(url);
  });
  it("does not invent a URL from a local T3 ID or a stale reboot identity", () => {
    expect(resolveWarmChatGPTConversationUrl(session(), null)).toBeNull();
    expect(
      resolveWarmChatGPTConversationUrl(
        session({
          bootstrapIdentity: { state: "awaiting_marker", conversationId: id },
        }),
        null,
      ),
    ).toBeNull();
    expect(
      resolveWarmChatGPTConversationUrl(
        session({
          bootstrapIdentity: { state: "mismatch", conversationId: id },
        }),
        null,
      ),
    ).toBeNull();
  });
});
