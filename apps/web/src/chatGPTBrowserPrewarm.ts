import type { EnvironmentId } from "@t3tools/contracts";

// A spare is a real, offscreen Electron webview with its own preview owner.
// It is deliberately NOT a sidebar session and never enters hidden-session lists.
export const chatGPTPrewarmKey = (environmentId: string) =>
  `t3code:chatgpt-browser:prewarm:${environmentId}`;

const readySpareByEnvironment = new Map<string, string>();

export function markChatGPTSpareReady(environmentId: EnvironmentId, sessionId: string): void {
  readySpareByEnvironment.set(environmentId, sessionId);
}

export function releaseChatGPTSpare(environmentId: EnvironmentId, sessionId: string): void {
  if (readySpareByEnvironment.get(environmentId) === sessionId)
    readySpareByEnvironment.delete(environmentId);
}

/** A spare may be consumed only once; readiness is intentionally not persisted. */
export function takeChatGPTSpare(environmentId: EnvironmentId, sessionId: string): boolean {
  if (readySpareByEnvironment.get(environmentId) !== sessionId) return false;
  readySpareByEnvironment.delete(environmentId);
  return true;
}

export function isChatGPTHomeUrl(url: string): boolean {
  try {
    const location = new URL(url);
    return (
      (location.hostname === "chatgpt.com" || location.hostname === "chat.openai.com") &&
      location.pathname === "/"
    );
  } catch {
    return false;
  }
}

// Executed only inside the existing ChatGPT guest. A completed navigation is
// not necessarily an interactive page; wait until the actual composer is ready.
function isChatGPTComposerReady(): boolean {
  if (!["chatgpt.com", "chat.openai.com", "www.chatgpt.com"].includes(location.hostname))
    return false;
  if (location.pathname !== "/") return false;
  const composer = document.querySelector(
    '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-input"], form textarea, [contenteditable="true"][role="textbox"]',
  );
  return !!composer && composer.getClientRects().length > 0;
}

export const CHATGPT_PREWARM_READY_EXPRESSION = `(${isChatGPTComposerReady.toString()})()`;
