import * as Schema from "effect/Schema";
import { useLocalStorage } from "./hooks/useLocalStorage";

export type ChatGPTViewKind = "session" | "browser";
export type ChatGPTViewOverride = ChatGPTViewKind | "default";
// v2 resets the one-time JPEG-era Session preference on native rollout.
// Users can still explicitly select Session afterward.
export const chatGPTDefaultViewKey = "t3code:chatgpt-browser:default-view:v2";
export const chatGPTSessionViewKey = (environmentId: string, sessionId: string) =>
  `t3code:chatgpt-browser:view-override:v2:${environmentId}:${sessionId}`;

const Kind = Schema.Literals(["session", "browser"]);
const Override = Schema.Literals(["default", "session", "browser"]);

export function useChatGPTDefaultView() {
  return useLocalStorage(chatGPTDefaultViewKey, "browser" as ChatGPTViewKind, Kind);
}
export function useChatGPTSessionViewOverride(environmentId: string, sessionId: string) {
  return useLocalStorage(
    chatGPTSessionViewKey(environmentId, sessionId),
    "default" as ChatGPTViewOverride,
    Override,
  );
}
/** A page's loading, login, navigation or reply state must never choose the user's view. */
export function resolveChatGPTView(
  preferred: ChatGPTViewKind,
  override: ChatGPTViewOverride,
): ChatGPTViewKind {
  return override === "default" ? preferred : override;
}
