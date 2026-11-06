import type { EnvironmentId } from "@t3tools/contracts";
import { chatGPTGuestKey } from "./chatGPTGuestHibernation";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { chatGPTBrowserThreadRef } from "../chatGPTBrowserSessions";
import { visibleSplitSessionIds } from "../chatGPTSplitLayout";

/** A selected or physically displayed guest must never be an automatic unload candidate. */
export function isChatGPTSessionViewed(
  environmentId: EnvironmentId,
  sessionId: string,
  view: {
    readonly pathname: string;
    readonly splitSessionIds: ReadonlySet<string>;
    readonly visibleRuntimeTabIds: readonly string[];
  },
): boolean {
  const selectedRouteId = view.pathname.match(/(?:^|\/)browser\/([^/]+)(?:\/|$)/)?.[1];
  if (selectedRouteId) {
    try {
      if (decodeURIComponent(selectedRouteId) === sessionId) return true;
    } catch {
      // A malformed browser route is not permission to unload any open pane.
      return true;
    }
    if (view.splitSessionIds.has(sessionId)) return true;
  }
  const key = JSON.stringify([
    environmentId, chatGPTBrowserThreadRef(environmentId, sessionId).threadId,
  ]);
  return view.visibleRuntimeTabIds.some((runtimeId) => chatGPTGuestKey(runtimeId) === key);
}

/** Read live navigation and surface state, not a React selection captured before an async probe. */
export function isChatGPTSessionBeingViewed(environmentId: EnvironmentId, sessionId: string): boolean {
  const surfaces = useBrowserSurfaceStore.getState().byTabId;
  return isChatGPTSessionViewed(environmentId, sessionId, {
    pathname: window.location.pathname,
    splitSessionIds: visibleSplitSessionIds(environmentId),
    visibleRuntimeTabIds: Object.keys(surfaces).filter((tabId) => surfaces[tabId]?.visible),
  });
}
