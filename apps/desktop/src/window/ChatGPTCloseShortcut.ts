import type * as Electron from "electron";

export const CLOSE_CHATGPT_SESSION_MENU_ACTION = "close-chatgpt-session";

/** Desktop uses hash routing; guest URL paths are unrelated to the T3 route. */
export function activeChatGPTBrowserSessionId(url: string): string | null {
  try {
    const { hash } = new URL(url);
    const match = /^#\/browser\/([^/?#]+)\/?(?:\?.*)?$/.exec(hash);
    return match ? decodeURIComponent(match[1]!) : null;
  } catch {
    return null;
  }
}

export function isChatGPTCloseShortcut(
  input: Pick<Electron.Input, "type" | "key" | "meta" | "control" | "alt" | "shift">,
  platform: NodeJS.Platform,
): boolean {
  return (
    input.type === "keyDown" &&
    input.key.toLowerCase() === "w" &&
    !input.alt &&
    !input.shift &&
    (platform === "darwin" ? input.meta && !input.control : input.control && !input.meta)
  );
}

/** Only a guest belonging to the currently selected browser session can close it. */
export function isChatGPTSessionPreviewTab(tabId: string, sessionId: string): boolean {
  try {
    const parts: unknown = JSON.parse(tabId);
    return Array.isArray(parts) && parts[1] === `t3-browser-session:${sessionId}`;
  } catch {
    return false;
  }
}
