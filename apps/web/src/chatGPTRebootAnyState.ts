import type { EnvironmentId } from "@t3tools/contracts";

import { wakeChatGPTGuest } from "./browser/chatGPTGuestHibernation";
import { isPersistentChatGPTSessionOptedIn } from "./browser/persistentChatGPTSessionMode";
import { nativeChatGPTResidency } from "./browser/nativeChatGPTWarmSession";
import { resetHostedBrowserGuest } from "./browser/hostedBrowserGuestReset";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { chatGPTBrowserLastUrlKey, chatGPTBrowserThreadRef } from "./chatGPTBrowserSessions";
import {
  releaseChatGPTDeliveryMount,
  requestChatGPTDeliveryMount,
} from "./chatGPTDeliveryMountRequest";
import { readDurableUnknownChatGPTSend } from "./chatGPTUncertainSendFence";
import { readThreadPreviewState } from "./previewStateStore";

export type RebootBrowserSlot =
  | { readonly kind: "native"; readonly environmentId: EnvironmentId; readonly sessionId: string }
  | { readonly kind: "webview"; readonly runtimeId: string };

/**
 * Agent Reboot is an explicit change of conversation, not a page reload.
 * An existing session can be working, stalled, hidden, loading or errored:
 * only the existence of its exact browser slot matters for the host reset.
 */
export async function findRebootBrowserSlot(
  environmentId: EnvironmentId,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<RebootBrowserSlot> {
  if (isPersistentChatGPTSessionOptedIn(sessionId)) {
    // Native Chromium pages live in Electron, not in a React <webview> or
    // preview tab. A missing native page is valid for an unloaded session;
    // actual creation/navigation happens only AFTER reboot intent is durable.
    if (!window.desktopBridge?.stableChatGPTViewRequest)
      throw new Error("Native Chromium bridge unavailable for Agent Reboot.");
    return { kind: "native", environmentId, sessionId };
  }
  requestChatGPTDeliveryMount(environmentId, sessionId);
  try {
    const ref = chatGPTBrowserThreadRef(environmentId, sessionId);
    const deadline = Date.now() + timeoutMs;
    do {
      const state = readThreadPreviewState(ref);
      const tabId = state.activeTabId ?? state.snapshot?.tabId;
      if (tabId && state.serverEpoch) {
        const runtimeId = previewRuntimeTabId(ref, state.serverEpoch, tabId);
        wakeChatGPTGuest(runtimeId);
        if (
          Array.from(document.querySelectorAll("webview")).some(
            (guest) => guest.dataset.previewTab === runtimeId,
          )
        )
          return { kind: "webview", runtimeId };
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    } while (true);
    throw new Error("T3 could not mount the existing browser slot for Agent Reboot.");
  } finally {
    releaseChatGPTDeliveryMount(environmentId, sessionId);
  }
}

/**
 * Save the *previous generation's* uncertain-send evidence before allowing
 * the new conversation to send its initial message. Its delivery is still
 * UNKNOWN; nothing from the predecessor is replayed or marked delivered.
 */
export function archivePriorRebootUnknownSend(
  environmentId: EnvironmentId,
  sessionId: string,
  priorConversationId: string,
  operationId: string,
): boolean {
  const receipt = readDurableUnknownChatGPTSend(environmentId, sessionId);
  if (!receipt) return false;
  const priorUrl = `https://chatgpt.com/c/${priorConversationId}`;
  const prefix = "t3code:chatgpt-unknown-send-fence:v1:";
  const oldKey = `${prefix}${environmentId}:${sessionId}`;
  const archivedKey = `t3code:chatgpt-reboot-unknown-archive:v1:${environmentId}:${sessionId}:${operationId}`;
  const original = window.localStorage.getItem(oldKey);
  if (!original) return false;
  const entry = JSON.stringify({
    ...receipt,
    originalConversationUrl: receipt.conversationUrl,
    originalMatchesRebootTarget: receipt.conversationUrl === priorUrl,
    operationId,
    archivedAt: Date.now(),
    delivery: "UNKNOWN",
    reason: "Agent Reboot initiated for same T3 browser slot",
  });
  const existing = window.localStorage.getItem(archivedKey);
  if (existing && existing !== entry) {
    // A prior successful archival may be retried after an UNKNOWN receipt.
    // Retain the earlier immutable evidence and never create a second send.
    return false;
  }
  window.localStorage.setItem(archivedKey, entry);
  if (window.localStorage.getItem(archivedKey) !== entry)
    throw new Error("Unable to preserve prior-generation UNKNOWN delivery receipt.");
  if (window.localStorage.getItem(oldKey) !== original)
    throw new Error("UNKNOWN send receipt changed while preparing Agent Reboot.");
  window.localStorage.removeItem(oldKey);
  if (window.localStorage.getItem(oldKey) !== null)
    throw new Error("Prior-generation send fence remains after archival.");
  return true;
}

/** The old URL remains recoverable even if the old guest cannot be queried. */
export function recordPriorRebootState(
  environmentId: EnvironmentId,
  sessionId: string,
  priorConversationId: string,
  operationId: string,
  draftBackup: "backed_up_empty" | "backed_up_nonempty" | "unavailable",
): void {
  const key = `t3code:chatgpt-reboot-predecessor:v1:${environmentId}:${sessionId}:${operationId}`;
  const savedUrl = window.localStorage.getItem(chatGPTBrowserLastUrlKey(environmentId, sessionId));
  const value = JSON.stringify({
    priorConversationId,
    priorUrl: priorConversationId
      ? `https://chatgpt.com/c/${priorConversationId}`
      : "https://chatgpt.com/",
    lastUrlBeforeReboot: savedUrl,
    draftBackup,
    recordedAt: Date.now(),
  });
  if (window.localStorage.getItem(key)) return;
  window.localStorage.setItem(key, value);
  if (window.localStorage.getItem(key) !== value)
    throw new Error("Failed to retain the previous ChatGPT conversation reference.");
}

/**
 * Explicit reboot may replace a working or errored page in the SAME session.
 * Existing native pages are navigated, not torn down or allocated a new UUID.
 * A missing native page is attached only after the reboot receipt was saved.
 */
export async function replaceRebootBrowserSlot(slot: RebootBrowserSlot): Promise<void> {
  const url = "https://chatgpt.com/";
  if (slot.kind === "webview") {
    await resetHostedBrowserGuest(slot.runtimeId, url);
    return;
  }
  const bridge = window.desktopBridge?.stableChatGPTViewRequest;
  if (!bridge) throw new Error("Native Chromium bridge unavailable for Agent Reboot.");
  const identity = { environmentId: slot.environmentId, sessionId: slot.sessionId, profileId: "default" };
  const residency = await nativeChatGPTResidency(bridge, slot.environmentId, slot.sessionId);
  if (residency === "resident") {
    // Navigation, rather than attach, starts a genuinely new conversation even
    // when the old native page is itself a home page with a restored draft.
    await bridge({ operation: "navigate", identity, url });
  } else if (residency === "missing") {
    // Native attach creates the absent owner; it does NOT navigate an existing
    // page if the UI mounted it while this command was in flight.
    const attached = (await bridge({ operation: "attach", identity, url })) as { url?: string };
    if (attached.url && attached.url !== url) {
      // Concurrent attach adopted an existing page. The explicit reboot still
      // needs to navigate that same owner to the new-chat home.
      await bridge({ operation: "navigate", identity, url });
    }
  } else {
    // Unknown IPC is not evidence of absence. Never allocate/reload blindly.
    throw new Error("Native Chromium slot could not be verified for Agent Reboot.");
  }
}
