import type { EnvironmentId } from "@t3tools/contracts";

import { wakeChatGPTGuest } from "./browser/chatGPTGuestHibernation";
import { resetHostedBrowserGuest } from "./browser/hostedBrowserGuestReset";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { chatGPTBrowserLastUrlKey, chatGPTBrowserThreadRef } from "./chatGPTBrowserSessions";
import { requestChatGPTDeliveryMount } from "./chatGPTDeliveryMountRequest";
import { readDurableUnknownChatGPTSend } from "./chatGPTUncertainSendFence";
import { readThreadPreviewState } from "./previewStateStore";

/**
 * Agent Reboot is an explicit change of conversation, not a page reload.
 * An existing session can be working, stalled, hidden, loading or errored:
 * only the existence of its exact browser slot matters for the host reset.
 */
export async function findRebootBrowserSlot(
  environmentId: EnvironmentId,
  sessionId: string,
  timeoutMs = 20_000,
): Promise<string> {
  requestChatGPTDeliveryMount(environmentId, sessionId);
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
        return runtimeId;
    }
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  } while (true);
  throw new Error("T3 could not mount the existing browser slot for Agent Reboot.");
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
    priorUrl: `https://chatgpt.com/c/${priorConversationId}`,
    lastUrlBeforeReboot: savedUrl,
    draftBackup,
    recordedAt: Date.now(),
  });
  if (window.localStorage.getItem(key)) return;
  window.localStorage.setItem(key, value);
  if (window.localStorage.getItem(key) !== value)
    throw new Error("Failed to retain the previous ChatGPT conversation reference.");
}

/** Replace the old guest even if it is working, disconnected or mid-load. */
export async function replaceRebootBrowserSlot(runtimeId: string): Promise<void> {
  await resetHostedBrowserGuest(runtimeId, "https://chatgpt.com/");
}
