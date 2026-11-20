// Pure guest-side error probe shared by T3 and Mori. No app/store dependencies.
/**
 * Executed inside a ChatGPT webview. Only recognize the new explicit
 * temporary-limit notice outside ordinary conversation text.
 */
export function hasChatGPTLoadFailure(): boolean {
  const message = "A temporary limit is preventing this chat from loading. Try again later.";
  const body = document.body;
  if (!body?.textContent?.includes("A temporary limit")) return false;
  const normalize = (text: string | null) =>
    (text ?? "")
      .replace(/\s+/g, " ")
      .replace(/([.!?])(?=[A-Z])/g, "$1 ")
      .trim();
  const visible = (element: Element): boolean => {
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (
        parent.hasAttribute("hidden") ||
        parent.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden"
      )
        return false;
    }
    // display:contents has no element rect, despite visibly rendered descendants.
    if (element.getClientRects().length) return true;
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getClientRects().length > 0;
  };
  const stop = document.querySelector(
    'button[data-testid="stop-button"], button[data-testid="composer-stop-button"]',
  );
  if (stop && visible(stop) && !stop.hasAttribute("disabled")) return false;

  // Do not mistake a user quoting this error for the site's own load failure.
  const turnSelector =
    '[data-message-author-role],[data-content-search-unit-key],[data-testid^="conversation-turn-"],' +
    '[data-testid*="user-message"],[data-testid*="assistant-message"],[data-turn-id],' +
    "[data-turn-key],[data-message-id],blockquote,pre,code,.markdown,.prose";
  const statusSelector =
    '[role="alert"],[role="status"],[data-testid*="error"],[data-state="error"]';
  const activeEditor = Array.from(
    body.querySelectorAll(
      'main textarea,main [contenteditable]:not([contenteditable="false"]),main [role="textbox"],' +
        '[role="main"] textarea,[role="main"] [contenteditable]:not([contenteditable="false"]),[role="main"] [role="textbox"]',
    ),
  ).some(visible);
  const activeTurns = Array.from(
    body.querySelectorAll(
      '[data-message-author-role],[data-content-search-unit-key],[data-testid^="conversation-turn-"],[data-turn-id]',
    ),
  ).some(visible);

  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    // The provider can split the sentence over several nested spans.
    if (!node.textContent?.includes("A temporary limit")) continue;
    const element = node.parentElement;
    if (!element || !visible(element)) continue;
    const status = element.closest(statusSelector);
    // A known chat turn is never a provider error; free-standing prose can be.
    const inTurn = element.closest(
      '[data-message-author-role],[data-content-search-unit-key],[data-testid^="conversation-turn-"],[data-turn-id]',
    );
    if (inTurn && !status) continue;
    if (element.closest(turnSelector) && (activeEditor || activeTurns) && !status) continue;
    // If there is an interactive chat or turns, require a real status region.
    // This also covers current ChatGPT UI variants with unfamiliar turn wrappers.
    if ((activeEditor || activeTurns) && !status) continue;
    for (
      let container: Element | null = element, depth = 0;
      container && container !== body && depth < 12;
      container = container.parentElement, depth++
    ) {
      const text = normalize(container.textContent);
      if (text === message && visible(container)) return true;
      if (text.length > 300) break;
    }
  }
  return false;
}

export const CHATGPT_LOAD_FAILURE_EXPRESSION = `(${hasChatGPTLoadFailure.toString()})()`;
