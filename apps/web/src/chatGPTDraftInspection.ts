/** A synchronous, read-only inspection of ONE guest composer. No transcript queries. */
export type ComposerProbe =
  | { readonly status: "unknown"; readonly url: string }
  | { readonly status: "empty" | "nonempty"; readonly url: string; readonly text: string };

export function inspectChatGPTComposer(doc: Document, url: string): ComposerProbe {
  const selectors = [
    "#prompt-textarea",
    '[data-testid="prompt-textarea"]',
    '[data-testid="composer-input"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][data-placeholder]',
    "textarea[placeholder]",
  ];
  for (const selector of selectors) {
    const element = doc.querySelector(selector);
    if (!element) continue;
    const tag = element.tagName.toLowerCase();
    const editable = element.getAttribute("contenteditable") === "true";
    if (!editable && tag !== "textarea") continue;
    const text =
      tag === "textarea"
        ? (element as HTMLTextAreaElement).value
        : ((element as HTMLElement).innerText ?? element.textContent ?? "");
    return { status: text.trim().length > 0 ? "nonempty" : "empty", url, text };
  }
  return { status: "unknown", url };
}

/** Evaluated only on a known, already-mounted Electron guest; never wakes a guest. */
export const CHATGPT_COMPOSER_PROBE_EXPRESSION = `(${inspectChatGPTComposer.toString()})(document, location.href)`;

/**
 * A fresh ChatGPT homepage with an empty text composer is not necessarily an
 * unused conversation: attachments, transcript turns and an in-flight upload
 * also disqualify it. This conservative check intentionally returns false on
 * unfamiliar composer layouts instead of inferring safety from absence.
 */
export function inspectUnusedNewChatMarkers(doc: Document, url: string): boolean {
  if (!/^https:\/\/chatgpt\.com\/?$/.test(url)) return false;
  if (doc.querySelector('[data-message-author-role], [data-testid="conversation-turn"]'))
    return false;
  const composer = doc.querySelector(
    '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-input"]',
  );
  const form = composer?.closest("form");
  if (!form) return false;
  if (
    form.querySelector(
      'img, video, audio, [data-testid="composer-attachment"], ' +
        '[data-testid="attachment-preview"], [data-testid="file-attachment"], ' +
        '[data-testid*="upload-preview"], [aria-label^="Remove file"], ' +
        '[aria-label^="Remove attachment"], [data-state="recording"], ' +
        '[data-state="uploading"]',
    )
  )
    return false;
  if (
    Array.from(form.querySelectorAll('input[type="file"]')).some(
      (input) => (input as HTMLInputElement).files?.length,
    )
  )
    return false;
  return true;
}

export const UNUSED_NEW_CHAT_MARKERS_EXPRESSION = `(${inspectUnusedNewChatMarkers.toString()})(document, location.href)`;

/** Prove transcript, attachment and composer absence twice on one mounted guest. */
export async function hasVerifiedUnusedNewChatGuest(
  guest: Pick<HTMLElementTagNameMap["webview"], "executeJavaScript">,
  expectedUrl: string,
): Promise<boolean> {
  try {
    const first = await guest.executeJavaScript(UNUSED_NEW_CHAT_MARKERS_EXPRESSION);
    if (first !== true || !(await hasVerifiedEmptyChatGPTComposer(guest, expectedUrl)))
      return false;
    const second = await guest.executeJavaScript(UNUSED_NEW_CHAT_MARKERS_EXPRESSION);
    return second === true;
  } catch {
    return false;
  }
}

export function sameComposerProbe(a: ComposerProbe, b: ComposerProbe): boolean {
  return (
    a.status !== "unknown" &&
    b.status !== "unknown" &&
    a.status === b.status &&
    a.url === b.url &&
    a.text === b.text
  );
}

/** Fail closed if either asynchronous inspection sees a draft, failure or redirect. */
export async function hasVerifiedEmptyChatGPTComposer(
  guest: Pick<HTMLElementTagNameMap["webview"], "executeJavaScript">,
  expectedUrl: string,
): Promise<boolean> {
  try {
    const first = (await guest.executeJavaScript(
      CHATGPT_COMPOSER_PROBE_EXPRESSION,
    )) as ComposerProbe;
    const second = (await guest.executeJavaScript(
      CHATGPT_COMPOSER_PROBE_EXPRESSION,
    )) as ComposerProbe;
    return (
      sameComposerProbe(first, second) && first.status === "empty" && first.url === expectedUrl
    );
  } catch {
    return false;
  }
}
