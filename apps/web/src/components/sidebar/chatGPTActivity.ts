import { hasChatGPTLoadFailure } from "./chatGPTConversationRecovery";

export const CHATGPT_RECENT_ACTIVITY_MS = 15 * 60 * 1_000;

export type ChatGPTActivityState =
  | "working"
  | "idle"
  | "unknown"
  | "invalid"
  | "interrupted"
  | "delivery-timeout";
export type ChatGPTActivityAge =
  | "working"
  | "snoozed"
  | "unloaded"
  | "recent"
  | "inactive"
  | "unknown"
  | "invalid"
  | "interrupted"
  | "delivery-timeout";

/** Keep the icon and the title on the same activity color, including for selected rows. */
export function chatGPTActivityColorClass(age: ChatGPTActivityAge): string {
  switch (age) {
    case "working":
      return "text-lime-500! dark:text-lime-400!";
    case "recent":
      return "text-[#5d82a9]! dark:text-[#88a9c8]!";
    case "snoozed":
    case "inactive":
      return "text-muted-foreground!";
    case "unloaded":
      return "text-zinc-600! dark:text-zinc-600!";
    case "unknown":
      return "text-sidebar-muted-foreground/60!";
    case "invalid":
      return "text-rose-600/80! dark:text-rose-400/80!";
    case "interrupted":
    case "delivery-timeout":
      return "text-orange-700! dark:text-orange-400!";
  }
}

export function chatGPTActivityAge(
  state: ChatGPTActivityState,
  lastWorkingAt: number,
  now: number,
): ChatGPTActivityAge {
  if (state !== "idle") return state === "working" ? "working" : state;
  if (
    Number.isFinite(lastWorkingAt) &&
    lastWorkingAt > 0 &&
    lastWorkingAt <= now &&
    now - lastWorkingAt < CHATGPT_RECENT_ACTIVITY_MS
  )
    return "recent";
  return "inactive";
}

// Executed inside the guest. Inspects visible status notices and composer
// controls only; never exports the conversation transcript to the host.
function readChatGPTActivity(loadFailure: boolean) {
  if (!["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(location.hostname))
    return "invalid: this page is not on ChatGPT";
  const visible = (element: Element) => {
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
    return element.getClientRects().length > 0;
  };

  if (loadFailure) return "invalid: Could not load this ChatGPT conversation";

  // ChatGPT can retain a Stop control after delivery fails. Treat a visible,
  // standalone notice as an interruption before checking the composer.
  const notices = [
    {
      prefix: "Connection interrupted",
      match: /^Connection interrupted\.\s*Waiting for the complete answer\.?$/i,
      state: "interrupted",
    },
    {
      prefix: "Message delivery timed out",
      match: /^Message delivery timed out\.\s*Please try again\.?$/i,
      state: "delivery-timeout",
    },
  ] as const;
  const body = document.body;
  // One read: textContent copies the whole conversation, and this runs per poll.
  const bodyText = body?.textContent ?? "";
  if (body) {
    for (const notice of notices) {
      if (!bodyText.includes(notice.prefix)) continue;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.includes(notice.prefix.split(" ")[0]!)) continue;
        const element = node.parentElement;
        if (!element || !visible(element)) continue;
        if (
          element.closest(
            '[data-message-author-role="user"], blockquote, pre, code, [contenteditable], textarea',
          )
        )
          continue;
        // Ignore error phrases quoted in the assistant's formatted answer,
        // but allow actual inline delivery errors within the assistant turn.
        if (
          notice.state === "delivery-timeout" &&
          element.closest(
            '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"] .prose',
          )
        )
          continue;
        // Status text may be split across sibling spans. Keep the match local
        // so a quoted sentence elsewhere in the conversation cannot trigger it.
        let container: Element | null = element;
        for (let depth = 0; container && depth < 4; depth++, container = container.parentElement) {
          const text = container.textContent?.replace(/\s+/g, " ").trim() ?? "";
          if (notice.match.test(text) && visible(container)) return notice.state;
          if (text.length > 150) break;
        }
      }
    }
  }

  const stop = document.querySelector(
    'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]',
  );
  if (stop && visible(stop) && !stop.hasAttribute("disabled")) return "working";
  const composer = document.querySelector(
    '#prompt-textarea, [data-testid="prompt-textarea"], form textarea, [contenteditable="true"][role="textbox"]',
  );
  return composer && visible(composer) ? "idle" : "invalid: the ChatGPT composer is unavailable";
}

// Reuse the recovery detector so the sidebar agrees with automatic recovery
// about the precise "Could not load conversation" failure panel.
export const CHATGPT_ACTIVITY_EXPRESSION = `(() => {
  const loadFailure = (${hasChatGPTLoadFailure.toString()})();
  return (${readChatGPTActivity.toString()})(loadFailure);
})()`;
