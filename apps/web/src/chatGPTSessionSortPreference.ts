import * as Schema from "effect/Schema";
import { useLocalStorage } from "./hooks/useLocalStorage";

export type ChatGPTSessionSortPreference = "activity" | "created";
export const CHATGPT_SESSION_SORT_PREFERENCE_KEY = "t3code:chatgpt-browser:activity-sort-preference";

/** Shared between the sidebar toggle and the Omniwork settings dropdown. */
export function useChatGPTSessionSortPreference() {
  return useLocalStorage(
    CHATGPT_SESSION_SORT_PREFERENCE_KEY,
    "activity" as ChatGPTSessionSortPreference,
    Schema.Literals(["activity", "created"]),
  );
}
