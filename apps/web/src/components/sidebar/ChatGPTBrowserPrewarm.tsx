import { AuthPreviewOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import {
  CHATGPT_NATIVE_PREWARM_READY_EXPRESSION,
  CHATGPT_PREWARM_READY_EXPRESSION,
  isChatGPTHomeUrl,
  markChatGPTSpareReady,
  releaseChatGPTSpare,
} from "../../chatGPTBrowserPrewarm";
import { CHATGPT_DEFAULT_URL, chatGPTBrowserThreadRef, useChatGPTBrowserSessions } from "../../chatGPTBrowserSessions";
import { isPersistentChatGPTSessionOptedIn } from "../../browser/persistentChatGPTSessionMode";
import { nativeChatGPTResidency, warmMissingNativeChatGPT } from "../../browser/nativeChatGPTWarmSession";
import { isElectron } from "../../env";
import { randomUUID } from "../../lib/utils";
import { readThreadPreviewState } from "../../previewStateStore";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";

import { ChatGPTBrowserSessionRuntime } from "./ChatGPTBrowserSessionRuntime";

// One spare preview owner (not a BrowserSession) preloads chatgpt.com. Electron's
// browser host keeps its webview mounted offscreen until createSession adopts
// the same owner ID; then this component immediately prepares the next spare.
export function ChatGPTBrowserPrewarm() {
  const environmentId = usePrimaryEnvironmentId();
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const { sessions, prewarmedSessionId, setPrewarmedSessionId } =
    useChatGPTBrowserSessions(environmentId);

  useEffect(() => {
    if (!isElectron || !environmentId || !canOperatePreview) return;
    if (!prewarmedSessionId || sessions.some((session) => session.id === prewarmedSessionId)) {
      setPrewarmedSessionId(randomUUID());
    }
  }, [canOperatePreview, environmentId, prewarmedSessionId, sessions, setPrewarmedSessionId]);

  if (
    !isElectron ||
    !environmentId ||
    !canOperatePreview ||
    !prewarmedSessionId ||
    sessions.some((session) => session.id === prewarmedSessionId)
  )
    return null;

  return (
    <ChatGPTBrowserPrewarmGuest
      key={`${environmentId}:${prewarmedSessionId}`}
      environmentId={environmentId}
      sessionId={prewarmedSessionId}
    />
  );
}

function ChatGPTBrowserPrewarmGuest({
  environmentId,
  sessionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
}) {
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );
  const native = isPersistentChatGPTSessionOptedIn(sessionId);

  // Keep exactly one native Chrome homepage preloaded, even without a visible
  // React browser surface. The view is owned by Electron and remains hidden
  // until a real user-created T3 session adopts this same UUID.
  useEffect(() => {
    if (!native) return;
    const bridge = window.desktopBridge?.stableChatGPTViewRequest;
    if (!bridge) return;
    let disposed = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let ready = false;
    const inspect = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const residency = await nativeChatGPTResidency(bridge, environmentId, sessionId);
        if (disposed) return;
        if (residency === "missing") {
          // Idempotent attach: NEVER re-navigate a page that another owner
          // mounted in the meantime. Unknown IPC does not authorize a load.
          await warmMissingNativeChatGPT(bridge, environmentId, sessionId, CHATGPT_DEFAULT_URL);
        }
        if (disposed || residency === "unknown") return;
        const identity = { environmentId, sessionId, profileId: "default" };
        const status = (await bridge({ operation: "snapshot", identity })) as {
          url?: string;
          destroyed?: boolean;
        };
        if (disposed || status.destroyed || !status.url || !isChatGPTHomeUrl(status.url)) return;
        const response = (await bridge({
          operation: "evaluate",
          identity,
          expression: CHATGPT_NATIVE_PREWARM_READY_EXPRESSION,
        })) as { result?: boolean };
        if (!disposed && response.result === true) {
          ready = true;
          markChatGPTSpareReady(environmentId, sessionId);
          return;
        }
        releaseChatGPTSpare(environmentId, sessionId);
      } catch {
        // Offline/login/loading pages are not ready spares. Never replace a
        // partially loaded page in an attempt to accelerate a new chat.
      } finally {
        inFlight = false;
        if (!disposed && !ready) poll = setTimeout(() => void inspect(), 1_500);
      }
    };
    void inspect();
    return () => {
      disposed = true;
      if (poll) clearTimeout(poll);
      releaseChatGPTSpare(environmentId, sessionId);
      // Do not close the native view; it may have just been adopted.
    };
  }, [environmentId, sessionId, native]);

  useEffect(() => {
    if (native) return;
    let disposed = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const inspect = async () => {
      const state = readThreadPreviewState(threadRef);
      const tabId = state.activeTabId;
      const nav = tabId ? state.sessions[tabId]?.navStatus : null;
      const overlay = tabId ? state.desktopByTabId[tabId] : null;
      if (
        tabId &&
        state.serverEpoch &&
        nav?._tag === "Success" &&
        isChatGPTHomeUrl(nav.url) &&
        overlay?.hasWebContents &&
        !overlay.loading
      ) {
        const runtimeId = previewRuntimeTabId(threadRef, state.serverEpoch, tabId);
        const webview = Array.from(document.querySelectorAll("webview")).find(
          (element) => element.dataset.previewTab === runtimeId,
        );
        if (webview) {
          try {
            const ready = await Promise.race([
              webview.executeJavaScript(CHATGPT_PREWARM_READY_EXPRESSION),
              new Promise<false>((resolve) => {
                timeout = setTimeout(() => resolve(false), 1_500);
              }),
            ]);
            if (!disposed && ready === true) {
              markChatGPTSpareReady(environmentId, sessionId);
              return;
            }
          } catch {
            // Guest attachment/navigation can fail temporarily; keep warming.
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        }
      }
      if (!disposed) poll = setTimeout(() => void inspect(), 1_500);
    };

    void inspect();
    return () => {
      disposed = true;
      if (poll) clearTimeout(poll);
      if (timeout) clearTimeout(timeout);
      releaseChatGPTSpare(environmentId, sessionId);
    };
  }, [environmentId, sessionId, threadRef, native]);

  if (native) return null;
  return (
    <ChatGPTBrowserSessionRuntime
      environmentId={environmentId}
      sessionId={sessionId}
      suspended={false}
      quiet
    />
  );
}
