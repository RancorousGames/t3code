import type { EnvironmentId } from "@t3tools/contracts";

import { isChatGPTHomeUrl } from "../chatGPTBrowserPrewarm";
import { readChatGPTBrowserSessions } from "../chatGPTBrowserSessions";
import { chatGPTSessionProfileId } from "../chatGPTAccountProfiles";
import { chatGPTConversationIdFromUrl } from "../chatGPTConversationIdentity";
import { CHATGPT_LOAD_FAILURE_EXPRESSION } from "../components/sidebar/chatGPTConversationRecovery";
import { inspectChatGPTComposer, CHATGPT_COMPOSER_PROBE_EXPRESSION, sameComposerProbe, type ComposerProbe } from "../chatGPTDraftInspection";
import { inspectPersistentChatGPTPage } from "./inspectPersistentChatGPTPage";

type NativeBridge = NonNullable<NonNullable<Window["desktopBridge"]>["stableChatGPTViewRequest"]>;

/** Manual/native recovery for the selected exact T3 slot. No legacy preview IDs. */
export async function guardedNativeChatGPTReload(input: {
  environmentId: EnvironmentId;
  sessionId: string;
  currentUrl: string | null;
  savedUrl: string | null;
  working: boolean;
  force: boolean;
  shouldContinue?: () => boolean;
  bridge?: NativeBridge;
}): Promise<{ recoveredUrl?: string; requestedNavigation?: boolean; nativeReloadIssued?: boolean }> {
  const bridge = input.bridge ?? window.desktopBridge?.stableChatGPTViewRequest;
  if (!bridge) throw new Error("Native Chromium reload bridge unavailable.");
  const profileId = chatGPTSessionProfileId(readChatGPTBrowserSessions(input.environmentId).find((entry) => entry.id === input.sessionId));
  const identity = { environmentId: input.environmentId, sessionId: input.sessionId, profileId };
  if (input.working && !input.force)
    throw new Error("Session is working. Pass force=true to deliberately interrupt generation.");
  const snapshot = (await bridge({ operation: "snapshot", identity })) as { url?: string; destroyed?: boolean };
  if (snapshot.destroyed || !snapshot.url || snapshot.url !== input.currentUrl)
    throw new Error("Native ChatGPT page changed or is unavailable; refusing reload.");
  const home = isChatGPTHomeUrl(snapshot.url);
  if (!home && !chatGPTConversationIdFromUrl(snapshot.url))
    throw new Error("Native page is not a canonical ChatGPT conversation.");
  if (home && (!input.savedUrl || !chatGPTConversationIdFromUrl(input.savedUrl)))
    throw new Error("No saved ChatGPT conversation identity; refusing native home recovery.");
  if (!home && input.savedUrl) {
    const savedId = chatGPTConversationIdFromUrl(input.savedUrl);
    if (savedId && savedId !== chatGPTConversationIdFromUrl(snapshot.url))
      throw new Error("Native ChatGPT page differs from saved conversation.");
  }

  // A genuine ChatGPT load-error page has no composer; the ordinary draft
  // guard therefore rejects every red recovery even when the error panel is
  // positively verified. This is a different, strictly read-only proof:
  // the dedicated error text AND its provider Retry/Try again button must
  // both be visible on the same exact conversation, twice independently.
  // No user turn/draft can exist in this error-panel state.
  const loadFailure = () => inspectPersistentChatGPTPage<boolean>(
    input.environmentId, input.sessionId, CHATGPT_LOAD_FAILURE_EXPRESSION,
  );
  if ((await loadFailure()) === true && (await loadFailure()) === true) {
    if (input.shouldContinue && !input.shouldContinue())
      throw new Error("Target session changed before verified load-error recovery.");
    const latest = (await bridge({ operation: "snapshot", identity })) as {
      url?: string; destroyed?: boolean;
    };
    if (latest.destroyed || latest.url !== snapshot.url)
      throw new Error("ChatGPT conversation changed before load-error recovery.");
    // The host owns the page, and acknowledges a native reload request
    // without requiring the navigation's renderer to return an evaluation
    // result (the old location.reload() JS evaluation was often aborted).
    await bridge({ operation: "reload", identity });
    return { nativeReloadIssued: true };
  }

  const probe = () => inspectPersistentChatGPTPage<ComposerProbe>(
    input.environmentId, input.sessionId, CHATGPT_COMPOSER_PROBE_EXPRESSION,
  );
  const first = await probe();
  const second = await probe();
  if (!first || !second || !sameComposerProbe(first, second) ||
      first.status !== "empty" || first.url !== snapshot.url)
    throw new Error("Native ChatGPT composer contains a draft or could not be verified empty.");
  if (input.shouldContinue && !input.shouldContinue())
    throw new Error("Target session changed before native recovery.");

  // Final draft, attachment, URL, and generation checks are in the SAME guest
  // JS turn as navigation. No asynchronous gap in which human text can be lost.
  const expression = `(() => {
    if (location.href !== ${JSON.stringify(snapshot.url)}) return false;
    const probe = (${inspectChatGPTComposer.toString()})(document, location.href);
    if (probe.status !== 'empty') return false;
    const editor = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"]');
    const form = editor?.closest('form');
    if (!form || form.querySelector('img,video,audio,[data-testid*="attachment"],[data-testid*="upload-preview"],[data-state="recording"],[data-state="uploading"],[aria-label^="Remove file"],[aria-label^="Remove attachment"]') ||
        Array.from(form.querySelectorAll('input[type="file"]')).some(input => input.files?.length)) return false;
    const stop = document.querySelector('[data-testid="stop-button"],[data-testid="composer-stop-button"],button[aria-label="Stop generating"]');
    if (!${input.force} && stop && stop.getClientRects().length && !stop.disabled) return false;
    if (${home}) location.assign(${JSON.stringify(input.savedUrl)});
    else location.reload();
    return true;
  })()`;
  const response = (await bridge({ operation: "evaluate", identity, expression })) as {
    result?: boolean;
  };
  if (response.result !== true)
    throw new Error("Native ChatGPT recovery was not positively acknowledged; do not repeat blindly.");
  return home
    ? { requestedNavigation: true, recoveredUrl: input.savedUrl! }
    : { nativeReloadIssued: true };
}
