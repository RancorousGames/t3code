import { openAgentAttention, rearmManualAgentAttention } from "./chatGPTAgentAttention";
import {
  type BrowserSession,
  updateChatGPTReturnMarker,
} from "./chatGPTBrowserSessions";
import { readChatGPTProviderActivity } from "./chatGPTProviderActivity";

/** Acknowledging a persistent Ctrl+D alert never disables its toggle.
 * Re-arm for the next working -> idle transition, not the current idle state. */
export function rearmPersistentSessionAttention(
  environmentId: string,
  session: BrowserSession,
): void {
  if (!session.returnMarker) return;
  updateChatGPTReturnMarker(environmentId, session.id, (marker) =>
    marker ? (readChatGPTProviderActivity(environmentId, session.id) === "working"
      ? "working" : "armed") : undefined);
  rearmManualAgentAttention([
    session.id,
    ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
  ]);
}

/** Visiting an attention session acknowledges one-time agent requests, but
 * only the user's Ctrl+D request automatically renews itself. */
export function acknowledgeChatGPTSessionAttention(
  environmentId: string,
  session: BrowserSession,
): void {
  openAgentAttention([
    session.id,
    ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
  ]);
  rearmPersistentSessionAttention(environmentId, session);
}
