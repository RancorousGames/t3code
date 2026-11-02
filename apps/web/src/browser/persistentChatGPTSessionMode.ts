/** Browser engine selection. Applied when the T3 UI initializes; switch only
 * during an intentional app restart to avoid losing in-flight browser pages. */
const EXACT_SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const PERSISTENT_CHATGPT_SESSION_PREFIX = "t3:chromium-session:";
export const CHATGPT_BROWSER_ENGINE_KEY = "t3code:chatgpt-browser-engine";
export type ChatGPTBrowserEngine = "native" | "webview";
export function configuredChatGPTBrowserEngine(): ChatGPTBrowserEngine {
  try {
    return localStorage.getItem(CHATGPT_BROWSER_ENGINE_KEY) === "webview" ? "webview" : "native";
  } catch {
    return "native";
  }
}
// sessionStorage survives renderer-only reloads, but not a new Electron owner.
// Keep the chosen engine fixed for the whole live browser-owner lifetime.
const activeEngine: ChatGPTBrowserEngine = (() => {
  try {
    const existing = sessionStorage.getItem(CHATGPT_BROWSER_ENGINE_KEY);
    if (existing === "native" || existing === "webview") return existing;
    const value = configuredChatGPTBrowserEngine();
    sessionStorage.setItem(CHATGPT_BROWSER_ENGINE_KEY, value);
    return value;
  } catch {
    return configuredChatGPTBrowserEngine();
  }
})();
export function isPersistentChatGPTSessionOptedIn(sessionId: string): boolean {
  return activeEngine === "native" && EXACT_SESSION_ID.test(sessionId);
}
