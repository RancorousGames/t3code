import { describe, expect, it } from "vite-plus/test";
import { resolveChatGPTGuestAttachUrl } from "./chatGPTGuestAttachUrl";
import type { BrowserSession } from "../chatGPTBrowserSessions";

const conversationId = "6ae291a4-e110-83eb-ad4d-dec6dfe17cb7";
const saved = `https://chatgpt.com/c/${conversationId}`;
const session: BrowserSession = { id: "legacy-t3-session", title: "Existing session",
  bootstrapIdentity: { state: "registered", conversationId } };

describe("restored ChatGPT guest attachment", () => {
  it("restores the exact saved conversation instead of attaching another homepage", () => {
    expect(resolveChatGPTGuestAttachUrl(session, saved, "https://chatgpt.com/")).toBe(saved);
  });
  it("recovers the registered identity if old local URL storage only contains home", () => {
    expect(resolveChatGPTGuestAttachUrl(session, "https://chatgpt.com", "https://chatgpt.com")).toBe(saved);
  });
  it("never redirects an already chosen conversation or another site", () => {
    const other = "https://chatgpt.com/c/6ae3bd70-41c0-83ed-bc66-6c2bb5aa781c";
    expect(resolveChatGPTGuestAttachUrl(session, saved, other)).toBe(other);
    expect(resolveChatGPTGuestAttachUrl(session, saved, "https://example.com")).toBe("https://example.com");
  });
  it("restores legacy sessions using a verified previous page observation", () => {
    expect(resolveChatGPTGuestAttachUrl({ id: "legacy", title: "Older session" }, null,
      "https://chatgpt.com", conversationId)).toBe(saved);
    expect(resolveChatGPTGuestAttachUrl({ id: "reboot", title: "Rebooting",
      bootstrapIdentity: { state: "awaiting_marker" } }, null,
      "https://chatgpt.com", conversationId)).toBe("https://chatgpt.com");
  });
  it("leaves new and unknown sessions alone", () => {
    expect(resolveChatGPTGuestAttachUrl(undefined, saved, "https://chatgpt.com")).toBe("https://chatgpt.com");
    expect(resolveChatGPTGuestAttachUrl({ id: "new", title: "New chat" }, null, "https://chatgpt.com")).toBe("https://chatgpt.com");
  });
});
