/**
 * Electron webviews are still the default. Opt-in T3 ChatGPT sessions can also
 * expose the same read/evaluate methods from an embedded Chromium frame surface.
 * Chromium-backed surfaces are never selected for ordinary preview tabs.
 */
export const MOUNTED_CHATGPT_GUEST_SELECTOR = 'webview, [data-t3-chromium-guest="true"]';

export function findMountedChatGPTGuest(runtimeTabId: string): HTMLElementTagNameMap["webview"] | null {
  return Array.from(document.querySelectorAll<HTMLElementTagNameMap["webview"]>(
    MOUNTED_CHATGPT_GUEST_SELECTOR,
  )).find((element) => element.dataset.previewTab === runtimeTabId) ?? null;
}

export function includesMountedChatGPTGuest(element: Element): boolean {
  return Array.from(document.querySelectorAll(MOUNTED_CHATGPT_GUEST_SELECTOR)).includes(element);
}
