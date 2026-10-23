/**
 * Local Electron webview automation for ChatGPT sessions.
 *
 * Upstream moved browser automation away from DesktopPreviewBridge. The desktop
 * renderer still owns its attached <webview> and can safely drive that guest
 * using the public Electron webview API without new privileged IPC endpoints.
 */
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";

type ChatGPTWebview = HTMLElementTagNameMap["webview"] & {
  getURL?: () => string;
  isLoading?: () => boolean;
  sendInputEvent?: (event: { type: "keyDown" | "keyUp"; keyCode: string }) => Promise<void>;
};

function findWebview(runtimeTabId: string): ChatGPTWebview {
  const guest = Array.from(document.querySelectorAll("webview")).find(
    (element) => element.dataset.previewTab === runtimeTabId,
  );
  if (!guest) throw new Error("ChatGPT guest webview has not attached.");
  return guest as ChatGPTWebview;
}

/** Guest DOM focus can move Electron keyboard focus away from T3's current pane.
 * Restore it only if the background guest is still the focused element; never
 * override a different focus target selected by the user during the operation.
 */
async function executeWithoutStealingHostFocus(webview: ChatGPTWebview, expression: string) {
  const previouslyFocused = document.hasFocus() ? document.activeElement : null;
  try {
    return await webview.executeJavaScript(expression);
  } finally {
    if (
      previouslyFocused instanceof HTMLElement &&
      previouslyFocused !== webview &&
      document.activeElement === webview
    ) {
      previouslyFocused.focus({ preventScroll: true });
    }
  }
}

function guestConversationGuardExpression(expectedConversationId: string | undefined): string {
  if (expectedConversationId === undefined) return "";
  // Runs INSIDE the guest JS turn that edits/clicks, never against a stale
  // navigation snapshot. Reject changes even during the send-button wait.
  return `const actualConversationId = (${chatGPTConversationIdFromUrl.toString()})(location.href);
    if (actualConversationId !== ${JSON.stringify(expectedConversationId)})
      return { guardMismatch: true, actualConversationId };`;
}

function assertGuestGuard(
  result: { guardMismatch?: boolean; actualConversationId?: string | null } | null,
) {
  if (result?.guardMismatch) {
    throw new Error(
      `ChatGPT conversation guard mismatch immediately before interaction: observed ${result.actualConversationId ?? "no ChatGPT conversation"}; refusing send.`,
    );
  }
}

export const chatGPTWebviewAutomation = {
  async status(runtimeId: string): Promise<{ available: boolean; loading: boolean; url: string }> {
    const webview = findWebview(runtimeId);
    let url = webview.getURL?.() ?? "";
    if (!url) {
      try {
        url = String(await webview.executeJavaScript("window.location.href"));
      } catch {
        url = "";
      }
    }
    return {
      available: Boolean(url),
      loading: webview.isLoading?.() ?? false,
      url,
    };
  },

  async waitFor(
    runtimeId: string,
    { selector, timeoutMs }: { selector: string; timeoutMs: number },
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const expression = `Boolean(document.querySelector(${JSON.stringify(selector)}))`;
    while (Date.now() < deadline) {
      try {
        if ((await findWebview(runtimeId).executeJavaScript(expression)) === true) return;
      } catch {
        // Guest may have navigated while the DOM was inspected.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 125));
    }
    // Include structural context (never text from a conversation or prompt)
    // so a sign-in/challenge screen is distinguishable from a renamed editor.
    let page = "unknown";
    try {
      const diagnostic = await findWebview(runtimeId).executeJavaScript(`(() => ({
        url: location.href,
        title: document.title,
        editorCount: document.querySelectorAll('[contenteditable], textarea').length,
        iframeCount: document.querySelectorAll('iframe').length,
      }))()`);
      page = JSON.stringify(diagnostic);
    } catch {
      // The guest might be navigating or detached.
    }
    throw new Error(`PreviewAutomationTargetNotFoundError: ${selector}; page: ${page}`);
  },

  async type(
    runtimeId: string,
    {
      selector,
      text,
      clear,
      expectedConversationId,
      requireEmptyComposer,
    }: {
      selector: string;
      text: string;
      clear?: boolean;
      requireEmptyComposer?: boolean;
      timeoutMs?: number;
      expectedConversationId?: string | undefined;
    },
  ): Promise<void> {
    // execCommand fires trusted contenteditable input events in Electron,
    // unlike assigning textContent directly (which bypasses ChatGPT/React).
    const expression = `(() => {
      ${guestConversationGuardExpression(expectedConversationId)}
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLElement))
        return { ok: false, reason: "PreviewAutomationTargetNotFoundError" };
      const value = ${JSON.stringify(text)};
      // One synchronous guest JS turn: NEVER erase a draft typed during async policy intake.
      if (${Boolean(requireEmptyComposer)}) {
        const current = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
          ? el.value : (el.innerText || el.textContent || "");
        if (current.trim()) return { ok: false, reason: "Composer contains an existing draft; refusing to overwrite it." };
      }
      el.focus();
      if (el.isContentEditable) {
        if (${Boolean(clear)}) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const selection = document.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
        const inserted = document.execCommand("insertText", false, value);
        // ProseMirror turns pasted newlines into paragraphs. textContent can
        // concatenate those nodes without separators, so compare innerText
        // using normalized whitespace rather than rejecting multiline prompts.
        const normalize = (text) => (text || "").replace(/\\s+/g, " ").trim();
        return {
          ok: inserted && normalize(el.innerText || el.textContent).includes(normalize(value)),
          reason: "Contenteditable rejected text",
        };
      }
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        if (${Boolean(clear)}) el.select();
        const inserted = document.execCommand("insertText", false, value);
        return { ok: inserted && el.value.includes(value), reason: "Input rejected text" };
      }
      return { ok: false, reason: "PreviewAutomationTargetNotFoundError" };
    })()`;
    const result = (await executeWithoutStealingHostFocus(findWebview(runtimeId), expression)) as {
      ok?: boolean;
      reason?: string;
      guardMismatch?: boolean;
      actualConversationId?: string | null;
    } | null;
    assertGuestGuard(result);
    if (result?.ok !== true) {
      throw new Error(result?.reason ?? "ChatGPT composer was not editable.");
    }
  },

  async press(
    runtimeId: string,
    { key, expectedConversationId }: { key: string; expectedConversationId?: string | undefined },
  ): Promise<void> {
    const webview = findWebview(runtimeId);
    if (key === "Enter") {
      // React enables/replaces the Send control after it processes the editor
      // input. Checking immediately after execCommand can race that update.
      const deadline = Date.now() + 8_000;
      let lastState: unknown;
      while (Date.now() < deadline) {
        const state = (await executeWithoutStealingHostFocus(
          webview,
          `(() => {
          ${guestConversationGuardExpression(expectedConversationId)}
          const editor = [
            '#prompt-textarea', '[data-testid="prompt-textarea"]',
            '[data-testid="composer-input"]', '[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"]', 'textarea'
          ].map((selector) => document.querySelector(selector)).find(Boolean);
          const selectors = [
            '[data-testid="send-button"]', '[data-testid="composer-submit-button"]',
            'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]',
            'button[aria-label="Send"]', 'button[type="submit"]',
            'button[aria-label^="Send "]', 'button[data-testid*="send"]'
          ];
          const candidates = [
            ...new Set(selectors.flatMap((selector) =>
              [...document.querySelectorAll(selector)]))
          ].filter((node) => node instanceof HTMLButtonElement);
          const button = candidates.find((node) => !node.disabled &&
            node.getAttribute('aria-disabled') !== 'true' &&
            node.getAttribute('aria-label') !== 'Stop' &&
            !node.matches('[data-testid="stop-button"]'));
          if (button) {
            button.click();
            return { clicked: true };
          }
          const form = editor?.closest('form');
          // Some ChatGPT layouts use an icon-only submit control. Submitting
          // the editor's own form invokes the same handler as clicking Send.
          if (form instanceof HTMLFormElement && form.querySelector('button[type="submit"]:not([disabled])')) {
            form.requestSubmit();
            return { clicked: true };
          }
          return {
            clicked: false,
            editorPresent: !!editor,
            editorLength: editor instanceof HTMLTextAreaElement
              ? editor.value.length : (editor?.textContent?.length ?? 0),
            controls: [...document.querySelectorAll('button')]
              .filter((node) => node.closest('form') === form || node.parentElement?.closest('form') === form)
              .slice(-12).map((node) => ({
                testId: node.getAttribute('data-testid'),
                label: node.getAttribute('aria-label'),
                type: node.getAttribute('type'),
                disabled: node.disabled
              }))
          };
        })()`,
        )) as {
          clicked?: boolean;
          guardMismatch?: boolean;
          actualConversationId?: string | null;
        } | null;
        assertGuestGuard(state);
        if (state?.clicked) return;
        lastState = state;
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
      }
      // Do not silently send Enter to the outer webview: that can shift focus
      // away from the editor and yield a false-positive no-op.
      throw new Error(
        "ChatGPT Send control did not become available: " + JSON.stringify(lastState),
      );
    }
    if (!webview.sendInputEvent) {
      throw new Error("The Electron webview does not support native keyboard input.");
    }
    await webview.sendInputEvent({ type: "keyDown", keyCode: key });
    await webview.sendInputEvent({ type: "keyUp", keyCode: key });
  },

  async evaluate(runtimeId: string, { expression }: { expression: string }): Promise<unknown> {
    return executeWithoutStealingHostFocus(findWebview(runtimeId), expression);
  },
};
