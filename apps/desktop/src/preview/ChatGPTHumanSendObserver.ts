// @effect-diagnostics globalTimers:off globalDate:off - Runs inside an Electron guest preload.
const COMPOSER_SELECTOR =
  '#prompt-textarea, [data-testid="prompt-textarea"], [data-testid="composer-input"], form textarea, [contenteditable="true"][role="textbox"]';
const SEND_BUTTON_SELECTOR =
  'button[data-testid="send-button"], button[data-testid="composer-send-button"], button[data-testid="composer-submit-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"], form button[type="submit"]';
const HUMAN_SEND_WINDOW_MS = 60_000;
export const VERIFIED_HUMAN_SEND_ATTRIBUTE = "data-t3code-human-chat-verified-at";

type TurnSnapshot = { count: number; lastKey: string | null };

/** Snapshot only message identity, never content; modern ChatGPT may virtualize old turns. */
function userTurns(doc: Document): TurnSnapshot {
  const roleNodes = doc.querySelectorAll('[data-message-author-role="user"]');
  const contentNodes = doc.querySelectorAll('[data-content-search-unit-key$=":user"]');
  const nodes = roleNodes.length
    ? [...roleNodes]
    : contentNodes.length
      ? [...contentNodes]
      : [...doc.querySelectorAll('[data-testid^="conversation-turn-"]')].filter((node) =>
          node.querySelector('[data-testid="user-message"], [data-message-author-role="user"]'),
        );
  const last = nodes.at(-1);
  return {
    count: nodes.length,
    lastKey:
      last?.closest("[data-turn-key]")?.getAttribute("data-turn-key") ??
      last?.getAttribute("data-content-search-unit-key") ??
      last?.closest('[data-testid^="conversation-turn-"]')?.getAttribute("data-testid") ??
      null,
  };
}

function isNewUserTurn(before: TurnSnapshot, after: TurnSnapshot): boolean {
  return (
    after.count > before.count ||
    (!!before.lastKey && !!after.lastKey && before.lastKey !== after.lastKey)
  );
}

/**
 * A trusted physical submit is merely intent. Persist adoption evidence only
 * after a *new rendered user turn* appears; scripts sending through T3 cannot
 * generate the initial trusted gesture via dispatchEvent/element.click().
 */
export function installChatGPTHumanSendObserver(win: Window & typeof globalThis, doc: Document) {
  if (!["chatgpt.com", "www.chatgpt.com"].includes(win.location.hostname))
    return {
      dispose: () => {},
      onKeyDown: (_event: KeyboardEvent) => {},
      onClick: (_event: MouseEvent) => {},
    };

  let observer: MutationObserver | null = null;
  let timeout: number | null = null;

  const clearPending = () => {
    observer?.disconnect();
    observer = null;
    if (timeout !== null) win.clearTimeout(timeout);
    timeout = null;
  };

  const expectHumanTurn = () => {
    const root = doc.documentElement;
    if (!root) return;
    clearPending();
    const before = userTurns(doc);
    const check = () => {
      if (!isNewUserTurn(before, userTurns(doc))) return;
      // The host reads this marker when it polls, including after the sidebar
      // filters the worker row. No lineage or OpenRig ownership is changed.
      root.setAttribute(VERIFIED_HUMAN_SEND_ATTRIBUTE, String(Date.now()));
      clearPending();
    };
    observer = new win.MutationObserver(check);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "data-turn-key",
        "data-content-search-unit-key",
        "data-message-author-role",
        "data-testid",
      ],
    });
    timeout = win.setTimeout(clearPending, HUMAN_SEND_WINDOW_MS);
    // ChatGPT may render the turn synchronously at the end of the trusted event.
    win.queueMicrotask(check);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      !event.isTrusted ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const target = event.target;
    if (!(target instanceof win.Element) || !target.closest(COMPOSER_SELECTOR)) return;
    const composer = target.closest(COMPOSER_SELECTOR) as HTMLElement | null;
    if (
      !(
        composer?.textContent?.trim() ||
        (composer instanceof win.HTMLTextAreaElement && composer.value.trim())
      )
    )
      return;
    expectHumanTurn();
  };

  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const button = target.closest<HTMLButtonElement>(SEND_BUTTON_SELECTOR);
    if (!button || button.disabled) return;
    // A generic form submit must belong to the ChatGPT composer, not another dialog.
    if (
      button.matches('form button[type="submit"]') &&
      !button.closest("form")?.querySelector(COMPOSER_SELECTOR)
    )
      return;
    expectHumanTurn();
  };

  win.addEventListener("keydown", onKeyDown, true);
  win.addEventListener("click", onClick, true);
  return {
    onKeyDown,
    onClick,
    dispose: () => {
      clearPending();
      win.removeEventListener("keydown", onKeyDown, true);
      win.removeEventListener("click", onClick, true);
    },
  };
}
