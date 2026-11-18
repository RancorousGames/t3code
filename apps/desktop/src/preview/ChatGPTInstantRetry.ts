// @effect-diagnostics globalDate:off globalTimers:off - Runs in ChatGPT's DOM, outside the Effect runtime.
/**
 * Runs inside an existing ChatGPT guest (preload or native page). Provider Retry
 * is an explicit failed-delivery affordance, not a new composer submission.
 * Observe DOM changes so it can be clicked without waiting for T3's recovery queue.
 */
export function installChatGPTInstantRetry(win: Window & typeof globalThis, doc: Document) {
  if (!["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(win.location.hostname))
    return { dispose: () => {} };

  const attempted = new WeakSet<Element>();
  let observer: MutationObserver | null = null;
  let checkQueued = false;
  let lastClickAt = 0;
  let retryTimer: number | null = null;
  let disposed = false;

  const visible = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true")
        return false;
      const style = win.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return el.getClientRects().length > 0;
  };
  const eligible = (button: Element) => {
    if (!visible(button) || button.hasAttribute("disabled") ||
        button.getAttribute("aria-disabled") === "true") return false;
    if (button.closest('blockquote,pre,code,[contenteditable],[data-message-author-role="user"],[data-content-search-unit-key$=":user"]'))
      return false;
    let parent: Element | null = button.parentElement;
    for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
      if (parent.closest('.markdown,.prose,[data-markdown-text-style="assistant-message"]'))
        return false;
      const content = (parent.textContent ?? "").replace(/\s+/g, " ").trim();
      if (/^(?:Message delivery timed out|Could not load this ChatGPT conversation|Something went wrong|An error occurred|There was an error|Network error|Failed to load (?:conversation|response)|Unable to load (?:conversation|response))[.!]?\s*(?:(?:Please )?(?:Retry|Try again)[.!]?)?$/i.test(content) ||
          /^Your account changed[.!]?\s*(?:Send your message again[.!]?)?\s*(?:(?:Retry|Try again|Send your message again)[.!]?)?$/i.test(content))
        return visible(parent);
      // ChatGPT also renders transient retry controls in an error alert without
      // an exact message; do not accept arbitrary Retry buttons in page content.
      if (parent.matches('[role="alert"], [data-state="error"]') &&
          /(?:error|failed|timed out|went wrong|unable to load|retry|account changed)/i.test(content))
        return visible(parent);
      if (content.length > 180) break;
    }
    return false;
  };
  const check = () => {
    checkQueued = false;
    if (disposed || !/^\/(?:g\/[^/]+\/)?c\/[0-9a-f-]{36}\/?$/i.test(win.location.pathname))
      return;
    for (const button of doc.querySelectorAll("button,[role='button']")) {
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
      if (attempted.has(button) || !/^(?:try again|retry|send your message again)$/i.test(label) ||
          !eligible(button)) continue;
      const remaining = 1_000 - (Date.now() - lastClickAt);
      if (remaining > 0) {
        if (retryTimer === null)
          retryTimer = win.setTimeout(() => { retryTimer = null; queueCheck(); }, remaining);
        return;
      }
      attempted.add(button);
      lastClickAt = Date.now();
      (button as HTMLElement).click();
      return;
    }
  };
  const queueCheck = () => {
    if (checkQueued || disposed) return;
    checkQueued = true;
    win.queueMicrotask(check);
  };
  const install = () => {
    if (disposed || !doc.documentElement || observer) return;
    observer = new win.MutationObserver(queueCheck);
    observer.observe(doc.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["disabled", "hidden", "style", "aria-hidden"],
    });
    queueCheck();
  };
  if (doc.documentElement) install();
  else doc.addEventListener("DOMContentLoaded", install, { once: true });
  return {
    dispose: () => {
      disposed = true;
      observer?.disconnect();
      if (retryTimer !== null) win.clearTimeout(retryTimer);
      doc.removeEventListener("DOMContentLoaded", install);
    },
  };
}
