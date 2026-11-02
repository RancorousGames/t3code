import { readChatGPTSessionProfileId } from "../chatGPTAccountProfiles";

/** Read-only inspection of the native ChatGPT WebContentsView owned by T3.
 * Never attaches, navigates, reloads, or changes a page. */
export async function inspectPersistentChatGPTPage<T>(
  environmentId: string,
  sessionId: string,
  expression: string,
): Promise<T | null> {
  const request = window.desktopBridge?.stableChatGPTViewRequest;
  if (!request) throw new Error("Native Chromium inspection bridge unavailable");
  const profileId = readChatGPTSessionProfileId(environmentId, sessionId);
  const identity = { environmentId, sessionId, profileId };
  // Background scanners inspect many unloaded sessions. Check the native
  // owner first, rather than repeatedly throwing from evaluate on missing views.
  const state = (await request({ operation: "probe", identity })) as {
    residency?: "resident" | "missing" | "mismatch" | "unavailable";
    destroyed?: boolean;
    url?: string;
  };
  if (state.residency !== "resident" || state.destroyed || !state.url) return null;
  const response = (await request({ operation: "evaluate", identity, expression })) as {
    result?: T;
  };
  return response.result ?? null;
}
