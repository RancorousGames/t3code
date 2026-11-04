import type { ChatGPTPromptAutomation } from "../chatGPTBrowserAutomation";
import { readChatGPTSessionProfileId } from "../chatGPTAccountProfiles";

type NativeBridge = NonNullable<NonNullable<Window["desktopBridge"]>["stableChatGPTViewRequest"]>;

/**
 * Readiness and evaluation for the exact Electron-owned Chromium guest. A
 * spawned first message is submitted directly via ChatGPT's React callback,
 * never by synthetic input, focus, or a click on the human composer.
 */
export function nativeChatGPTInitialPromptAutomation(
  bridge: NativeBridge,
  environmentId: string,
  sessionId: string,
): ChatGPTPromptAutomation {
  const profileId = readChatGPTSessionProfileId(environmentId, sessionId);
  const identity = { environmentId, sessionId, profileId };
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = (await bridge({ operation: "evaluate", identity, expression })) as {
      result?: unknown;
    };
    return result.result;
  };
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    async status() {
      const snapshot = (await bridge({ operation: "snapshot", identity })) as {
        url?: string;
        destroyed?: boolean;
        loading?: boolean;
      };
      return {
        available: !snapshot.destroyed && Boolean(snapshot.url),
        loading: snapshot.loading === true,
        url: snapshot.url ?? "",
      };
    },
    async waitFor(_runtimeId, { selector, timeoutMs }) {
      const deadline = Date.now() + timeoutMs;
      do {
        if ((await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) === true)
          return;
        await pause(125);
      } while (Date.now() < deadline);
      throw new Error("Native ChatGPT composer has not become available.");
    },
    async evaluate(_runtimeId, { expression }) {
      return evaluate(expression);
    },
  };
}
