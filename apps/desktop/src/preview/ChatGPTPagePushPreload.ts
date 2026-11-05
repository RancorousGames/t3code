// @effect-diagnostics globalDate:off globalTimers:off -- Sandboxed guest preload, no Effect runtime.
export const CHATGPT_PAGE_PUSH_CHANNEL = "preview:chatgpt-page-push";
export const CHATGPT_PUSH_DEBOUNCE_MS = 150;
export const CHATGPT_PUSH_MIN_INTERVAL_MS = 800;

export function installChatGPTPagePushObserver(
  doc: Document,
  locationInfo: Pick<Location, "hostname">,
  send: () => void,
  scheduler: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
    now: () => number;
  } = { setTimeout, clearTimeout, now: Date.now },
): () => void {
  if (!["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(locationInfo.hostname))
    return () => {};
  let disposed = false;
  let handle: ReturnType<typeof setTimeout> | undefined;
  let lastEmitAt = 0;
  const emit = () => {
    handle = undefined;
    if (disposed) return;
    lastEmitAt = scheduler.now();
    send(); // Read-only hint. Host validates the attached guest and takes one bounded snapshot.
  };
  const onChange = () => {
    if (disposed || handle !== undefined) return;
    const delay = Math.max(CHATGPT_PUSH_DEBOUNCE_MS,
      CHATGPT_PUSH_MIN_INTERVAL_MS - (scheduler.now() - lastEmitAt));
    handle = scheduler.setTimeout(emit, delay);
  };
  const observer = new MutationObserver(onChange);
  let target: Element | null = null;
  const attach = () => {
    if (!doc.documentElement || disposed) return;
    // Avoid watching unrelated ChatGPT sidebar animations and navigation;
    // the conversation/composer lives under main on supported page layouts.
    // Before hydration, watch the root only until main is mounted.
    const next = doc.querySelector("main,[role=main]") ?? doc.documentElement;
    if (next === target) return;
    target = next;
    observer.disconnect();
    observer.observe(next, {
      subtree: true, childList: true, characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "disabled", "aria-busy", "aria-label"],
    });
    onChange();
  };
  // React may replace <main> during SPA navigation without a document load.
  // Inspect only connectivity for ordinary subtree changes; rebind immediately
  // when the observed root is detached instead of waiting for a timer.
  const rootObserver = new MutationObserver(() => {
    if (!target?.isConnected || target === doc.documentElement) attach();
  });
  const start = () => {
    if (!doc.documentElement) return;
    rootObserver.observe(doc.documentElement, { subtree: true, childList: true });
    attach();
  };
  if (doc.documentElement) start();
  else doc.addEventListener("DOMContentLoaded", start, { once: true });
  const dispose = () => {
    disposed = true;
    observer.disconnect();
    rootObserver.disconnect();
    doc.removeEventListener("DOMContentLoaded", start);
    if (handle !== undefined) scheduler.clearTimeout(handle);
    handle = undefined;
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return () => {
    window.removeEventListener("pagehide", dispose);
    dispose();
  };
}
