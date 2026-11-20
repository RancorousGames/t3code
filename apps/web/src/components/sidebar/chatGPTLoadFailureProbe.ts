// Pure guest-side error probe shared by T3 and Mori. No app/store dependencies.
/**
 * Executed inside a ChatGPT webview. Only recognize the new explicit
 * temporary-limit notice outside ordinary conversation text.
 */
export function hasChatGPTLoadFailure(): boolean {
  const message = "A temporary limit is preventing this chat from loading. Try again later.";
  const body = document.body;
  if (!body?.textContent?.includes("A temporary limit")) return false;
  const visible = (element: Element): boolean => {
    for (let n: Element | null = element; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (
        n.hasAttribute("hidden") ||
        n.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden"
      )
        return false;
    }
    return element.getClientRects().length > 0;
  };
  const stop = document.querySelector(
    'button[data-testid="stop-button"], button[data-testid="composer-stop-button"]',
  );
  if (stop && visible(stop) && !stop.hasAttribute("disabled")) return false;

  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.includes("A temporary limit")) continue;
    const element = node.parentElement;
    if (
      !element ||
      !visible(element) ||
      (element.closest(
        '[data-message-author-role], [data-content-search-unit-key], [data-testid^="conversation-turn-"], [data-turn-key], article, pre, code, blockquote, .markdown, .prose',
      ) &&
        !element.closest(
          '[role="alert"], [role="status"], [data-testid*="error"], [data-state="error"]',
        ))
    )
      continue;
    let container: Element | null = element;
    for (let depth = 0; container && depth < 5 && container !== body; depth++) {
      const text = container.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (text === message && visible(container)) return true;
      if (text.length > 200) break;
      container = container.parentElement;
    }
  }
  return false;
}

export const CHATGPT_LOAD_FAILURE_EXPRESSION = `(${hasChatGPTLoadFailure.toString()})()`;
