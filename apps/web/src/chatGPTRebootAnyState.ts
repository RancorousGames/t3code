import type { EnvironmentId } from "@t3tools/contracts";

import { wakeChatGPTGuest } from "./browser/chatGPTGuestHibernation";
import { resetHostedBrowserGuest } from "./browser/hostedBrowserGuestReset";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { chatGPTBrowserLastUrlKey, chatGPTBrowserThreadRef } from "./chatGPTBrowserSessions";
import {
  releaseChatGPTDeliveryMount,
  requestChatGPTDeliveryMount,
} from "./chatGPTDeliveryMountRequest";
import { readThreadPreviewState } from "./previewStateStore";

export type RebootBrowserSlot = { readonly kind: "webview"; readonly runtimeId: string };

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
 * Only the existing exact Electron webview is reset.
 */
export async function replaceRebootBrowserSlot(slot: RebootBrowserSlot): Promise<void> {
  await resetHostedBrowserGuest(slot.runtimeId, "https://chatgpt.com/");
}
