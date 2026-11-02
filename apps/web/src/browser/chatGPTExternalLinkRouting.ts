/** Canonical ChatGPT conversations can be reopened in an existing T3 slot. */
export function canonicalChatGPTLink(target: string): string | null {
  try {
    const url = new URL(target);
    if (url.protocol !== "https:" ||
        !["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(url.hostname)) return null;
    const match = /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(url.pathname);
    return match ? `https://chatgpt.com/c/${match[1]}` : null;
  } catch {
    return null;
  }
}

// Only T3-owned ChatGPT guests externalize ordinary HTTP(S) links; their
// conversations and authentication flows must retain the guest's profile.
export function shouldOpenChatGPTLinkInDefaultBrowser(
  threadId: string,
  source: string | null,
  target: string,
): boolean {
  if (!threadId.startsWith("t3-browser-session:") || !source) return false;
  try {
    const from = new URL(source);
    const to = new URL(target);
    if (
      !["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(from.hostname.toLowerCase())
    )
      return false;
    if (!["http:", "https:"].includes(from.protocol) || !["http:", "https:"].includes(to.protocol))
      return false;
    return ![
      "chatgpt.com",
      "www.chatgpt.com",
      "chat.openai.com",
      "auth.openai.com",
      "auth0.openai.com",
      "accounts.google.com",
      "login.microsoftonline.com",
      "appleid.apple.com",
      "challenges.cloudflare.com",
    ].includes(to.hostname.toLowerCase());
  } catch {
    return false;
  }
}
