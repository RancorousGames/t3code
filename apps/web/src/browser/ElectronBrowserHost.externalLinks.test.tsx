// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";

import { shouldOpenChatGPTLinkInDefaultBrowser } from "./ElectronBrowserHost";

describe("ChatGPT preview link routing", () => {
  const sessionId = "t3-browser-session:worker";
  const currentUrl = "https://chatgpt.com/c/real";

  it("routes outbound HTTP(S) links through the desktop default-browser path", () => {
    expect(
      shouldOpenChatGPTLinkInDefaultBrowser(sessionId, currentUrl, "https://example.com/article"),
    ).toBe(true);
    expect(
      shouldOpenChatGPTLinkInDefaultBrowser(sessionId, currentUrl, "http://github.com/issue"),
    ).toBe(true);
  });

  it("retains ChatGPT conversations, sign-in, and OAuth destinations with the guest profile", () => {
    for (const url of [
      "https://chatgpt.com/c/another",
      "https://www.chatgpt.com/",
      "https://chat.openai.com/c/another",
      "https://auth.openai.com/authorize",
      "https://accounts.google.com/o/oauth2/auth",
      "https://login.microsoftonline.com/common/oauth2",
      "https://appleid.apple.com/auth/authorize",
    ])
      expect(shouldOpenChatGPTLinkInDefaultBrowser(sessionId, currentUrl, url)).toBe(false);
  });

  it("does not externalize non-ChatGPT previews, unknown source URLs, or unsafe/file schemes", () => {
    expect(
      shouldOpenChatGPTLinkInDefaultBrowser("normal-thread", currentUrl, "https://example.com"),
    ).toBe(false);
    expect(shouldOpenChatGPTLinkInDefaultBrowser(sessionId, null, "https://example.com")).toBe(
      false,
    );
    expect(
      shouldOpenChatGPTLinkInDefaultBrowser(
        sessionId,
        "https://example.com",
        "https://another.com",
      ),
    ).toBe(false);
    for (const target of [
      "file:///C:/private.txt",
      "javascript:alert(1)",
      "data:text/plain,hello",
      "vscode://open",
      "about:blank",
      "not-a-url",
    ])
      expect(shouldOpenChatGPTLinkInDefaultBrowser(sessionId, currentUrl, target)).toBe(false);
  });
});
