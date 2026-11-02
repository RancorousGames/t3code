import * as Schema from "effect/Schema";
import { getChatGPTSessionPersistedStore } from "./chatGPTSessionPersistedStore";
import { getLocalStorageItem, setLocalStorageItemAndNotify } from "./hooks/useLocalStorage";

/** Stable local ChatGPT account identities. The switch affects NEW manual sessions only. */
export const PRIMARY_CHATGPT_PROFILE_ID = "default";
export const SECONDARY_CHATGPT_PROFILE_ID = "chatgpt-second";
export type ChatGPTAccountProfileId =
  | typeof PRIMARY_CHATGPT_PROFILE_ID
  | typeof SECONDARY_CHATGPT_PROFILE_ID;

export const chatGPTNewSessionProfileKey = (environmentId: string | null) =>
  `t3code:chatgpt-browser:new-profile:${environmentId ?? "unconnected"}`;

export function readNewChatGPTProfileId(environmentId: string | null): ChatGPTAccountProfileId {
  if (typeof window === "undefined") return PRIMARY_CHATGPT_PROFILE_ID;
  try {
    return getLocalStorageItem(chatGPTNewSessionProfileKey(environmentId), Schema.String) ===
      SECONDARY_CHATGPT_PROFILE_ID
      ? SECONDARY_CHATGPT_PROFILE_ID
      : PRIMARY_CHATGPT_PROFILE_ID;
  } catch {
    return PRIMARY_CHATGPT_PROFILE_ID;
  }
}

/** A manual new-chat action consumes its selection, then defaults the next to blue. */
export function resetNewChatGPTProfileId(environmentId: string | null): void {
  try {
    setLocalStorageItemAndNotify(
      chatGPTNewSessionProfileKey(environmentId),
      PRIMARY_CHATGPT_PROFILE_ID,
      Schema.String,
    );
  } catch {
    // Session creation must not fail if local browser storage is unavailable.
  }
}

/** Legacy sessions without an explicit profile always remain on the original account. */
export function chatGPTSessionProfileId(
  session: { readonly profileId?: string | undefined } | null | undefined,
): string {
  return session?.profileId || PRIMARY_CHATGPT_PROFILE_ID;
}

/** Read the exact persisted identity without requiring a React component or branded environment. */
export function readChatGPTSessionProfileId(environmentId: string, sessionId: string): string {
  try {
    return chatGPTSessionProfileId(
      getChatGPTSessionPersistedStore(environmentId).getState().sessions.find(
        (entry) => entry.id === sessionId,
      ),
    );
  } catch {
    // Offline/test renderers without browser storage have only the legacy identity.
    return PRIMARY_CHATGPT_PROFILE_ID;
  }
}
