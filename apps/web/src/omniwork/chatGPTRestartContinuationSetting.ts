import * as Schema from "effect/Schema";
import { getLocalStorageItem, useLocalStorage } from "../hooks/useLocalStorage";

const KEY = "t3code:chatgpt-browser:resume-managed-after-restart:v1";

/** Only managed sessions with independently verified interrupted work qualify.
 * Turning this off never cancels or alters an existing conversation or monitor. */
export function readChatGPTRestartContinuationEnabled(): boolean {
  try {
    return getLocalStorageItem(KEY, Schema.Boolean) ?? true;
  } catch {
    return false; // Corrupt/unavailable preferences fail closed for automatic sends.
  }
}
export function useChatGPTRestartContinuationEnabled() {
  return useLocalStorage(KEY, true, Schema.Boolean);
}
