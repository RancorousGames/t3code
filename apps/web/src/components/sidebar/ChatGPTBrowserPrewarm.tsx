import { AuthPreviewOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { previewRuntimeTabId } from "../../browser/previewRuntimeTabId";
import {
  CHATGPT_PREWARM_READY_EXPRESSION,
  isChatGPTHomeUrl,
  markChatGPTSpareReady,
  releaseChatGPTSpare,
} from "../../chatGPTBrowserPrewarm";
import { chatGPTBrowserThreadRef, useChatGPTBrowserSessions } from "../../chatGPTBrowserSessions";
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

  useEffect(() => {
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
  }, [environmentId, sessionId, threadRef]);

  return (
    <ChatGPTBrowserSessionRuntime
      environmentId={environmentId}
      sessionId={sessionId}
      suspended={false}
      quiet
    />
  );
}
