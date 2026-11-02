/**
 * Local experiment only: evaluate an explicit expression in one exact ChatGPT
 * guest. This does not replace normal send, delivery receipts or the queue.
 */

export type ExperimentalChatGPTSessionProvenance = {
  creationOrigin?: "manual" | "backend" | undefined;
  spawnRequestId?: string | undefined;
  humanControlled?: boolean | undefined;
};

/** A fresh, conversation-less chat is a valid target only for a backend-owned
 * session. A manually created chat, unknown origin, or backend chat taken over
 * by a human still requires an exact existing conversation ID. */
export function allowsChatGPTExperimentalNewChat(
  session: ExperimentalChatGPTSessionProvenance,
  guestUrl: string,
): boolean {
  if (session.creationOrigin === "manual" || session.humanControlled === true) return false;
  if (session.creationOrigin !== "backend" && !session.spawnRequestId?.trim()) return false;
  try {
    const url = new URL(guestUrl);
    return url.protocol === "https:" &&
      (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") &&
      url.pathname === "/" && !url.hash;
  } catch {
    return false;
  }
}

/** The backend-new-chat flag is assigned by the renderer from persisted T3
 * creation provenance, never by the CLI/caller. No conversation UUID is minted
 * locally: ChatGPT itself assigns one if the experimental expression sends. */
export function buildChatGPTExperimentalExpression(
  conversationId: string | null,
  expression: string,
  allowBackendNewChat = false,
): string {
  const newBackendChat = conversationId === null && allowBackendNewChat;
  if (!newBackendChat &&
      (conversationId === null ||
       !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(conversationId)))
    throw new Error("An exact conversation UUID is required except for backend-created fresh chats.");
  if (!expression.trim() || expression.length > 8_000)
    throw new Error("The experiment requires a 1..8000 character JS expression.");

  return `(async () => {
    const validHost = () => ['chatgpt.com', 'chat.openai.com'].includes(location.hostname);
    const newBackendChat = ${JSON.stringify(newBackendChat)};
    const originalPath = ${JSON.stringify(newBackendChat ? "/" : "/c/" + conversationId)};
    if (!validHost() || location.pathname !== originalPath)
      return { ok: false, reason: 'Guest conversation changed before experiment.' };
    const editor = document.querySelector(
      '#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"],form textarea,[contenteditable="true"][role="textbox"]'
    );
    if (!editor) return { ok: false, reason: 'ChatGPT composer is not mounted.' };
    const draft = editor instanceof HTMLTextAreaElement
      ? editor.value : (editor.innerText || editor.textContent || '');
    if (draft.trim()) return { ok: false, reason: 'Composer has an unsent draft.' };
    const stop = document.querySelector(
      '[data-testid="stop-button"],[data-testid="composer-stop-button"],button[aria-label="Stop generating"]'
    );
    if (stop && stop.getClientRects().length && !stop.disabled)
      return { ok: false, reason: 'ChatGPT appears to be generating.' };
    try {
      const result = await (${expression});
      const json = JSON.stringify(result ?? null);
      if (!json || json.length > 8_000)
        return { ok: false, reason: 'Experiment result is not a small JSON value.' };
      if (!validHost())
        return { ok: false, reason: 'Guest navigated away; outcome may be unknown.' };
      if (newBackendChat) {
        const created = /^\\/c\\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\\/?$/i.exec(location.pathname);
        if (location.pathname !== "/" && !created)
          return { ok: false, reason: 'Guest navigated unexpectedly; outcome may be unknown.' };
        return { ok: true, value: JSON.parse(json), observedConversationId: created?.[1] ?? null };
      }
      if (location.pathname !== originalPath)
        return { ok: false, reason: 'Guest navigated during experiment; outcome may be unknown.' };
      return { ok: true, value: JSON.parse(json) };
    } catch (error) {
      return { ok: false, reason: String(error).slice(0, 500) };
    }
  })()`;
}
