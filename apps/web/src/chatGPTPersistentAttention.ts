import { openAgentAttention, openAgentAttentionRequest, rearmManualAgentAttention } from "./chatGPTAgentAttention";
import type { ChatGPTActivityState } from "./components/sidebar/chatGPTActivity";
import {
  type BrowserSession,
  updateChatGPTReturnMarker,
} from "./chatGPTBrowserSessions";

/** Acknowledging a persistent Ctrl+D alert never disables its toggle.
 * Re-arm for the next working -> idle transition, not the current idle state. */
export function rearmPersistentSessionAttention(
  environmentId: string,
  session: BrowserSession,
  activity: ChatGPTActivityState,
): void {
  if (!session.returnMarker) return;
  updateChatGPTReturnMarker(environmentId, session.id, (marker) =>
    marker ? (activity === "working" ? "working" : "armed") : undefined);
  rearmManualAgentAttention([
    session.id,
    ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
  ], session.title);
}

/** Opening a notification acknowledges exactly that entry, even when a
 * session has several pending agent/manual requests. An ordinary sidebar
 * selection still acknowledges the entire session as before. */
export function acknowledgeChatGPTSessionAttention(
  environmentId: string,
  session: BrowserSession,
  activity: ChatGPTActivityState,
  requestId?: string,
): boolean {
  const ids = [
    session.id,
    ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
  ];
  if (requestId !== undefined) {
    const request = openAgentAttentionRequest(requestId, ids);
    if (!request) return false;
    // A one-time agent request must not consume the user's separate Ctrl+D alert.
    if (request.source === "manual")
      rearmPersistentSessionAttention(environmentId, session, activity);
    return true;
  }
  openAgentAttention(ids);
  rearmPersistentSessionAttention(environmentId, session, activity);
  return true;
}
