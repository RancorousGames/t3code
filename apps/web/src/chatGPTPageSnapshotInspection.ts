export interface ChatGPTPageSnapshot {
  readonly observedAt: number;
  readonly url: string;
  readonly conversationId: string;
  readonly activity: "working" | "idle" | "interrupted" | "failed" | "unknown";
  readonly signals: {
    readonly stopButton: boolean;
    /** True only after a trusted human click on Stop for this observed working turn. */
    readonly explicitStopRequested?: boolean;
    readonly interruptedBanner: boolean;
    readonly loadError: boolean;
    readonly composerPresent: boolean;
    readonly draftPresent: boolean;
    readonly signInOrCaptcha: boolean;
    readonly conversationFull: boolean;
  };
  readonly turnCount: number;
  /** The final visible message role; older assistant text cannot prove a new reply. */
  readonly lastTurnRole?: "user" | "assistant" | null;
  readonly lastUser?: { readonly text: string; readonly truncated: boolean };
  readonly lastAssistant?: {
    readonly text: string;
    readonly truncated: boolean;
    readonly endsWithQuestion: boolean;
  };
  readonly contentHash: string;
}

/**
 * Runs inside an already attached ChatGPT guest as part of the existing activity probe.
 * Inspects rendered turns only. The composer is queried solely for a boolean; its
 * contents are NEVER returned or persisted.
 */
export function inspectChatGPTPageSnapshot(activityState: string): ChatGPTPageSnapshot | null {
  if (!["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(location.hostname))
    return null;
  const match = new URL(location.href).pathname.match(
    /^(?:\/g\/[^/]+)?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i,
  );
  if (!match) return null; // Keep the last valid conversation during login/navigation.
  const visible = (node: Element | null) => !!node && node.getClientRects().length > 0;
  const composer = document.querySelector(
    '#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]',
  );
  const stop = document.querySelector(
    'button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]',
  );
  const stopButton = visible(stop) && !stop?.hasAttribute("disabled");
  // A disappearance of Stop alone is NOT a user cancellation (it also occurs
  // on network failures and incomplete replies). Record a trusted click in the
  // already-attached page, scoped to the precise working turn and conversation.
  // This marker is in-memory only: reload/navigation cannot fabricate a stop.
  type StopWitness = {
    installed: boolean;
    workingTurn: number | null;
    conversation: string | null;
    clickedTurn: number | null;
    clickedConversation: string | null;
    clickedAt: number;
  };
  const scopedWindow = window as typeof window & { __t3ExplicitStopWitness?: StopWitness };
  const witness = scopedWindow.__t3ExplicitStopWitness ??= {
    installed: false, workingTurn: null, conversation: null,
    clickedTurn: null, clickedConversation: null, clickedAt: 0,
  };
  if (!witness.installed) {
    witness.installed = true;
    document.addEventListener("click", (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const button = event.target.closest(
        'button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]',
      );
      if (!button || !visible(button) || button.hasAttribute("disabled") ||
          witness.workingTurn === null || !witness.conversation) return;
      witness.clickedTurn = witness.workingTurn;
      witness.clickedConversation = witness.conversation;
      witness.clickedAt = Date.now();
    }, true);
  }
  const composerPresent = visible(composer);
  // Draft presence is safe to store. Do not return draft characters, hashes or lengths.
  const draftPresent =
    !!composer &&
    Boolean(
      (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
        ? composer.value
        : (composer as HTMLElement).innerText || composer.textContent || ""
      ).trim(),
    );
  const alerts = [
    ...document.querySelectorAll('[role="alert"],[role="status"],[data-testid*="error"]'),
  ]
    .filter(
      (node) => visible(node) && !node.closest("[data-message-author-role],pre,code,blockquote"),
    )
    .map((node) => (node.textContent ?? "").slice(0, 400));
  const conversationFull = alerts.some((text) =>
    /conversation (?:is )?(?:too long|full)|maximum (?:conversation )?length/i.test(text),
  );
  const signInOrCaptcha = !!document.querySelector(
    'iframe[src*="captcha"],iframe[src*="challenge"],input[autocomplete="current-password"],[data-testid="login-button"]',
  );
  const loadError =
    activityState.includes("Could not load") ||
    alerts.some((text) => /could not load (?:this )?conversation/i.test(text));
  const interruptedBanner = activityState === "interrupted";
  const roleNodes = [
    ...document.querySelectorAll(
      '[data-message-author-role="user"],[data-message-author-role="assistant"]',
    ),
  ];
  const turnNodes = [...document.querySelectorAll('[data-testid^="conversation-turn-"]')];
  const units = [
    ...document.querySelectorAll(
      '[data-content-search-unit-key$=":user"],[data-content-search-unit-key$=":assistant"]',
    ),
  ];
  const nodes = roleNodes.length ? roleNodes : turnNodes.length ? turnNodes : units;
  let turnCount = 0;
  let sawTurn = false;
  let lastUserNode: Element | null = null;
  let lastAssistantNode: Element | null = null;
  let lastTurnRole: "user" | "assistant" | null = null;
  for (const node of nodes) {
    const key = node.getAttribute("data-content-search-unit-key");
    const role =
      node.getAttribute("data-message-author-role") ??
      node.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role") ??
      (key?.endsWith(":user") ? "user" : key?.endsWith(":assistant") ? "assistant" : null) ??
      (node.querySelector('[data-testid="user-message"],.whitespace-pre-wrap')
        ? "user"
        : node.querySelector('.markdown,.prose,[data-testid="assistant-message"]')
          ? "assistant"
          : null);
    if (role === "user") {
      lastTurnRole = "user";
      turnCount++;
      sawTurn = true;
      lastUserNode = node;
    } else if (role === "assistant") {
      lastTurnRole = "assistant";
      if (!sawTurn) {
        turnCount++;
        sawTurn = true;
      }
      lastAssistantNode = node;
    }
  }
  if (stopButton && activityState === "working") {
    witness.workingTurn = turnCount;
    witness.conversation = match[1]!;
  }
  const explicitStopRequested =
    !stopButton && (activityState === "idle") &&
    witness.clickedTurn === turnCount &&
    witness.clickedConversation === match[1] &&
    witness.clickedAt > 0 && Date.now() - witness.clickedAt < 120_000;
  // Only materialize two DOM text values regardless of conversation length.
  const userContent =
    lastUserNode?.querySelector('[data-testid="user-message"],.whitespace-pre-wrap') ??
    lastUserNode;
  const assistantContent =
    lastAssistantNode?.querySelector(
      '[data-markdown-text-style="assistant-message"],.markdown,.prose',
    ) ?? lastAssistantNode;
  const userText =
    (userContent as HTMLElement | null)?.innerText?.trim() ||
    userContent?.textContent?.trim() ||
    "";
  const assistantText =
    (assistantContent as HTMLElement | null)?.innerText?.trim() ||
    assistantContent?.textContent?.trim() ||
    "";
  const excerpt = (text: string, tail = false) => ({
    text: text.length > 600 ? (tail ? text.slice(-600) : text.slice(0, 600)) : text,
    truncated: text.length > 600,
  });
  const lastUser = userText ? excerpt(userText) : undefined;
  const lastAssistant = assistantText
    ? {
        ...excerpt(assistantText, true),
        endsWithQuestion: /[?ï¼Ÿ]\s*$/.test(assistantText),
      }
    : undefined;
  // Stable FNV-1a over the *bounded displayed* content, not the draft. No secret
  // transcript fragments travel beyond these two excerpts.
  const hashInput = JSON.stringify([
    match[1],
    turnCount,
    lastUser?.text ?? "",
    lastAssistant?.text ?? "",
  ]);
  let hash = 2166136261;
  for (let i = 0; i < hashInput.length; i++) {
    hash ^= hashInput.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const activity =
    activityState === "working" || activityState === "idle" || activityState === "interrupted"
      ? activityState
      : activityState.startsWith("invalid:") || activityState === "delivery-timeout"
        ? "failed"
        : "unknown";
  return {
    observedAt: Date.now(),
    url: location.href,
    conversationId: match[1]!,
    activity,
    signals: {
      stopButton,
      explicitStopRequested,
      interruptedBanner,
      loadError,
      composerPresent,
      draftPresent,
      signInOrCaptcha,
      conversationFull,
    },
    turnCount,
    lastTurnRole,
    ...(lastUser ? { lastUser } : {}),
    ...(lastAssistant ? { lastAssistant } : {}),
    contentHash: (hash >>> 0).toString(16).padStart(8, "0"),
  };
}
