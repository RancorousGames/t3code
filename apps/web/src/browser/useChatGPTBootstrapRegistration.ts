import { useEffect } from "react";
import { findMountedChatGPTGuest } from "./mountedChatGPTGuest";
import { isPersistentChatGPTSessionOptedIn } from "./persistentChatGPTSessionMode";
import { chatGPTSessionProfileId } from "../chatGPTAccountProfiles";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  chatGPTBrowserThreadRef,
  readChatGPTBrowserSessions,
  useChatGPTBrowserSessions,
} from "../chatGPTBrowserSessions";
import {
  inspectChatGPTBootstrapMarker,
  inspectChatGPTBootstrapMarkerViaApi,
  needsChatGPTBootstrapMarker,
  type ChatGPTBootstrapObservation,
} from "../chatGPTBootstrapIdentity";
import { readThreadPreviewState } from "../previewStateStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function isObservation(value: unknown): value is ChatGPTBootstrapObservation {
  const observation = value as Partial<ChatGPTBootstrapObservation> | null;
  return (
    !!observation &&
    typeof observation === "object" &&
    typeof observation.conversationId === "string" &&
    UUID.test(observation.conversationId) &&
    typeof observation.markerId === "string" &&
    UUID.test(observation.markerId)
  );
}

/** Last probe outcome per internal session ID. Surfaced by session-control
 * `read` so a stuck registration shows where it stopped. */
const lastProbe = new Map<string, { readonly stage: string; readonly at: string }>();
// The API fallback is best effort. Never hammer a throttled ChatGPT endpoint.
const apiRetryAfterBySession = new Map<string, number>();
let globalApiRetryAfter = 0;
let globalLastApiAt = 0;
export function readChatGPTBootstrapProbe(sessionId: string) {
  return lastProbe.get(sessionId) ?? null;
}

/** Scans the session's ChatGPT page for its first assistant [T3_ID:uuid]
 * marker until one registers. Uses native Chromium evaluation for Chrome
 * views and mounted webview evaluation for legacy sessions. A slow heartbeat
 * covers native pages that do not emit webview push events. The DOM is checked
 * first; the conversation API handles collapsed markers at most every 30s. */
export function useChatGPTBootstrapRegistration(environmentId: EnvironmentId, sessionId: string) {
  const { sessions, registerBootstrapMarker, resolveBootstrapTitle } =
    useChatGPTBrowserSessions(environmentId);
  const owner = sessions.find((entry) => entry.id === sessionId);
  const scanning = owner !== undefined && needsChatGPTBootstrapMarker(owner);
  useEffect(() => {
    if (!scanning) return;
    let disposed = false;
    let running = false;
    let again = false;
    let lastRunAt = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const note = (stage: string) =>
      lastProbe.set(sessionId, { stage, at: new Date().toISOString() });
    const probe = async () => {
      if (running) {
        again = true;
        return;
      }
      // Page pushes fire continuously while a reply streams; probe at most every 3s.
      const wait = lastRunAt + 3_000 - Date.now();
      if (wait > 0) {
        trailing ??= setTimeout(() => {
          trailing = undefined;
          void probe();
        }, wait);
        return;
      }
      running = true;
      lastRunAt = Date.now();
      try {
        const entry = readChatGPTBrowserSessions(environmentId).find(
          (item) => item.id === sessionId,
        );
        if (disposed || !entry || !needsChatGPTBootstrapMarker(entry)) return;
        const native = isPersistentChatGPTSessionOptedIn(sessionId);
        const ref = chatGPTBrowserThreadRef(environmentId, sessionId);
        const state = readThreadPreviewState(ref);
        if (!native && !state.activeTabId) return note("no_active_tab");
        const runtimeId = state.activeTabId
          ? previewRuntimeTabId(ref, state.serverEpoch, state.activeTabId)
          : null;
        const guest = native || !runtimeId ? null : findMountedChatGPTGuest(runtimeId);
        if (!native && !guest) return note("no_guest");
        const bridge = native ? window.desktopBridge?.stableChatGPTViewRequest : undefined;
        if (native && !bridge) return note("no_native_bridge");
        const identity = { sessionId, environmentId, profileId: chatGPTSessionProfileId(entry) };
        const initialPage = native
          ? ((await bridge!({ operation: "probe", identity })) as {
              residency?: "resident" | "missing" | "mismatch";
              url?: string;
              destroyed?: boolean;
            })
          : null;
        if (native && (initialPage?.residency !== "resident" || initialPage?.destroyed || !initialPage?.url))
          return note("native_not_ready");
        const evaluate = async (expression: string): Promise<unknown> => {
          if (bridge) {
            const response = (await bridge({ operation: "evaluate", identity, expression })) as {
              result?: unknown;
            };
            return response.result;
          }
          return guest!.executeJavaScript(expression);
        };
        let result: unknown = await evaluate(`(${inspectChatGPTBootstrapMarker.toString()})()`);
        if (disposed) return;
        if (!isObservation(result)) {
          const now = Date.now();
          if (now < Math.max(globalApiRetryAfter, apiRetryAfterBySession.get(sessionId) ?? 0) ||
              now - globalLastApiAt < 60_000) return note("dom_no_marker_api_cooldown");
          globalLastApiAt = now;
          result = await evaluate(`(${inspectChatGPTBootstrapMarkerViaApi.toString()})()`);
          if (disposed) return;
          if (!isObservation(result)) {
            const stage = typeof result === "string" ? result : "api_no_marker";
            if (stage === "api_http_429") globalApiRetryAfter = Date.now() + 10 * 60_000;
            else if (/^api_http_(?:403|5\d\d)$|^api_no_token$/.test(stage))
              apiRetryAfterBySession.set(sessionId, Date.now() + 5 * 60_000);
            else apiRetryAfterBySession.set(sessionId, Date.now() + 60_000);
            return note(stage);
          }
        }
        const observation = result;
        // Native Chrome views have no DOM webview element. Recheck the exact page
        // before accepting its assistant marker; never claim another conversation.
        if (native) {
          const current = (await bridge!({ operation: "snapshot", identity })) as {
            url?: string;
            destroyed?: boolean;
          };
          if (
            current.destroyed ||
            current.url !== initialPage?.url ||
            !current.url?.includes(`/c/${observation.conversationId}`)
          )
            return note("native_page_changed");
        }
        // Ignore results from a legacy guest that navigated or was replaced meanwhile.
        if (
          !native &&
          (!guest!.isConnected ||
            guest!.dataset.previewTab !== runtimeId ||
            !guest!.getURL().includes(`/c/${observation.conversationId}`))
        )
          return note("guest_changed");
        registerBootstrapMarker(sessionId, {
          conversationId: observation.conversationId,
          markerId: observation.markerId,
          proposedTitle: observation.proposedTitle,
        });
        // The assistant marker is the only browser ownership evidence needed
        // to resolve Bootstrap's separately persisted UUID -> title association.
        // The existing streamed-title and spawned-session paths remain intact.
        const lookup = window.desktopBridge?.readChatGPTBootstrapTitle;
        if (lookup) {
          void lookup(observation.markerId)
            .then((title) => {
              // Registration itself unmounts this scanner; the resolver validates
              // the current persisted ID/conversation, not the old effect lifetime.
              resolveBootstrapTitle(
                sessionId,
                observation.markerId,
                observation.conversationId,
                title,
              );
            })
            .catch(() => undefined);
        }
        note(`marker:${observation.markerId}`);
      } catch (error) {
        note(`error:${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = false;
        if (again && !disposed) {
          again = false;
          void probe();
        }
      }
    };
    // Native pages and restored/offscreen legacy guests may not emit page pushes.
    const poll = setInterval(() => void probe(), 20_000);
    const onPush = (event: Event) => {
      const detail = (event as CustomEvent<{ runtimeTabId?: string }>).detail;
      const ref = chatGPTBrowserThreadRef(environmentId, sessionId);
      const state = readThreadPreviewState(ref);
      if (
        state.activeTabId &&
        detail?.runtimeTabId === previewRuntimeTabId(ref, state.serverEpoch, state.activeTabId)
      )
        void probe();
    };
    window.addEventListener("t3:chatgpt-page-push", onPush);
    void probe();
    return () => {
      disposed = true;
      clearInterval(poll);
      if (trailing !== undefined) clearTimeout(trailing);
      window.removeEventListener("t3:chatgpt-page-push", onPush);
    };
  }, [scanning, environmentId, sessionId, registerBootstrapMarker, resolveBootstrapTitle]);
}
