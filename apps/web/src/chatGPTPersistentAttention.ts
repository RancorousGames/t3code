import { openAgentAttention, rearmManualAgentAttention } from "./chatGPTAgentAttention";
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
  ]);
}

/** Visiting an attention session acknowledges one-time agent requests, but
 * only the user's Ctrl+D request automatically renews itself. */
export function acknowledgeChatGPTSessionAttention(
  environmentId: string,
  session: BrowserSession,
  activity: ChatGPTActivityState,
): void {
  openAgentAttention([
    session.id,
    ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
  ]);
  rearmPersistentSessionAttention(environmentId, session, activity);
}
