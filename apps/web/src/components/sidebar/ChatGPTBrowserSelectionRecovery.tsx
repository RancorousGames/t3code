import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { recoverSelectedBlankChatGPTSession } from "../../chatGPTSelectedSessionRecovery";

/** Selection is the user-triggered high-priority recovery path. */
export function ChatGPTBrowserSelectionRecovery({
  environmentId,
  sessionId,
  enabled,
  clickToken,
}: {
  environmentId: EnvironmentId;
  sessionId?: string | undefined;
  enabled: boolean;
  clickToken: number;
}) {
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let mounted = true;
    void recoverSelectedBlankChatGPTSession({
      environmentId,
      sessionId,
      isCurrent: () => mounted,
    }).catch((error: unknown) => {
      if (mounted)
        console.warn("[ChatGPT selected blank recovery] Could not inspect selected session:", error);
    });
    return () => { mounted = false; };
  }, [environmentId, sessionId, enabled, clickToken]);
  return null;
}
