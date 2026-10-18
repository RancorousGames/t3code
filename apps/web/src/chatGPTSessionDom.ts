export interface PageMessage {
  role: "user" | "assistant";
  text: string;
  turn: number;
}
export interface PageInspection {
  activity: "working" | "idle" | "unknown";
  stuck: boolean;
  connectionInterrupted: boolean;
  /** Sidebar activity probe output; shares exactly its guest-side rules. */
  uiActivity?: string;
  totalTurns: number;
  lastRole: "user" | "assistant" | null;
  lastText: string;
  messages: PageMessage[];
  url: string;
  diagnostics?: { roleElements: number; turnElements: number; textLength: number; title: string };
}

// Serialized into the authenticated ChatGPT guest, never executed in the T3 host.
// Reads only visible conversation DOM; it neither uses ChatGPT private APIs nor cookies.
export function inspectChatGPTPage(input: {
  from: "start" | "end";
  count: number;
  includeMessages: boolean;
}) {
  const url = location.href;
  if (!["chatgpt.com", "chat.openai.com", "www.chatgpt.com"].includes(location.hostname))
    return {
      activity: "unknown",
      stuck: false,
      connectionInterrupted: false,
      totalTurns: 0,
      lastRole: null,
      lastText: "",
      messages: [],
      url,
    };
  const visible = (el: Element) => el.getClientRects().length > 0;
  const stop = document.querySelector(
    'button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]',
  );
  const working = !!stop && visible(stop) && !stop.hasAttribute("disabled");
  const composer = document.querySelector(
    '#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]',
  );
  const activity = working ? "working" : composer && visible(composer) ? "idle" : "unknown";
  // ChatGPT may display this connection banner while its Stop button is still
  // present. Detect the *visible notice* before classifying active generation.
  // This state is transient: ChatGPT can reconnect without intervention.
  const interruptedText = /^Connection interrupted\.\s*Waiting for the complete answer\.?$/i;
  let connectionInterrupted = false;
  if (document.body?.textContent?.includes("Connection interrupted")) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.includes("Connection interrupted")) continue;
      const element = node.parentElement;
      if (
        !element ||
        !visible(element) ||
        element.closest(
          '[data-message-author-role="user"],blockquote,pre,code,[contenteditable],textarea',
        )
      )
        continue;
      // The notice may be split between a few sibling spans. Avoid matching
      // mentions buried inside long messages or the entire app shell.
      let candidate: Element | null = element;
      for (let depth = 0; candidate && depth < 3; depth++, candidate = candidate.parentElement) {
        const text = candidate.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (interruptedText.test(text) && visible(candidate)) {
          connectionInterrupted = true;
          break;
        }
        if (text.length > 150) break;
      }
      if (connectionInterrupted) break;
    }
  }
  // Evaluating the load-failure probe is delegated to T3's existing detector.
  const stuck = false;
  // ChatGPT changes its message wrappers periodically. Prefer explicit roles,
  // then fall back to conversation-turn wrappers when role attributes disappear.
  const roleNodes = [
    ...document.querySelectorAll(
      '[data-message-author-role="user"],[data-message-author-role="assistant"]',
    ),
  ];
  const turnNodes = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
  const nodes = roleNodes.length ? roleNodes : turnNodes;
  // Count roles first. For a status scan, never extract the whole conversation:
  // a tab with thousands of messages would otherwise flood the Electron bridge.
  const indexed: { node: Element; role: "user" | "assistant"; turn: number }[] = [];
  let turn = -1;
  for (const node of nodes) {
    const explicitRole =
      node.getAttribute("data-message-author-role") ??
      node.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role");
    const role =
      explicitRole === "user" || explicitRole === "assistant"
        ? explicitRole
        : node.querySelector('[data-testid="user-message"], .whitespace-pre-wrap')
          ? "user"
          : node.querySelector('.markdown, .prose, [data-testid="assistant-message"]')
            ? "assistant"
            : null;
    if (role !== "user" && role !== "assistant") continue;
    if (role === "user" || turn < 0) turn++;
    indexed.push({ node, role, turn });
  }
  const totalTurns = turn + 1;
  const last = indexed.at(-1);
  const getText = (node: Element) =>
    (node as HTMLElement).innerText?.trim() || node.textContent?.trim() || "";
  const from = input.from === "start" ? 0 : Math.max(0, totalTurns - input.count);
  const to = input.from === "start" ? input.count : totalTurns;
  return {
    activity,
    stuck,
    connectionInterrupted,
    totalTurns,
    lastRole: last?.role ?? null,
    lastText: last ? getText(last.node).slice(-400) : "",
    messages: input.includeMessages
      ? indexed
          .filter((m) => m.turn >= from && m.turn < to)
          .map((m) => ({ role: m.role, turn: m.turn, text: getText(m.node).slice(0, 6000) }))
      : [],
    url,
    diagnostics: input.includeMessages
      ? {
          roleElements: document.querySelectorAll("[data-message-author-role]").length,
          turnElements: document.querySelectorAll('[data-testid^="conversation-turn-"]').length,
          textLength: document.body?.textContent?.length ?? 0,
          title: document.title,
        }
      : undefined,
  };
}
