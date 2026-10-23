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
