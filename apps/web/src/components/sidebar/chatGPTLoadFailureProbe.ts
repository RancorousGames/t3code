// Pure guest-side error probe shared by T3 and Mori. No app/store dependencies.
/**
 * Executed inside a ChatGPT webview. Only recognize the dedicated error panel:
 * a visible exact error string alongside the provider's Retry/Try again button.
 */
export function hasChatGPTLoadFailure(): boolean {
  const message = "Could not load this ChatGPT conversation";
  const body = document.body;
  if (!body?.textContent?.includes(message)) return false;
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
    if (node.textContent?.trim() !== message) continue;
    const element = node.parentElement;
    if (
      !element ||
      !visible(element) ||
      element.closest(
        '[data-message-author-role], [data-testid^="conversation-turn-"], article, pre, code',
      )
    )
      continue;
    let container: Element | null = element;
    for (let depth = 0; container && depth < 5 && container !== body; depth++) {
      for (const button of container.querySelectorAll('button, [role="button"]')) {
        if (/^(?:retry|try again)$/i.test(button.textContent?.trim() ?? "") && visible(button))
          return true;
      }
      container = container.parentElement;
    }
  }
  return false;
}

export const CHATGPT_LOAD_FAILURE_EXPRESSION = `(${hasChatGPTLoadFailure.toString()})()`;
