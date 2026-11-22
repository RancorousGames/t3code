import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";

export type DirectSubmitResult = { submitted: boolean; reason?: string };

/**
 * Evaluated inside the exact ChatGPT guest. Calls React's mounted submit
 * callback with explicit text, never editing/focusing the user's composer.
 * React internals are unstable: if the known handler cannot be identified,
 * return a definite no-submit rather than typing or clicking as a fallback.
 */
export function chatGPTDirectSubmitExpression(input: {
  text: string;
  expectedConversationId?: string | undefined;
  expectedNewChat?: boolean | undefined;
  sendExpiresAt?: number | undefined;
}): string {
  if (
    !input.text.trim() ||
    Boolean(input.expectedConversationId) === Boolean(input.expectedNewChat)
  )
    throw new Error(
      "Direct submission requires text and exactly one target: conversation or fresh chat.",
    );

  return `(() => {
    const expected = ${JSON.stringify(input.expectedConversationId ?? null)};
    const fresh = ${input.expectedNewChat === true};
    const expiresAt = ${JSON.stringify(input.sendExpiresAt ?? null)};
    const validTarget = () => {
      if (!['chatgpt.com', 'chat.openai.com'].includes(location.hostname) ||
          location.protocol !== 'https:' ||
          (expiresAt !== null && Date.now() >= expiresAt)) return false;
      if (fresh) return location.pathname === '/' && !location.hash;
      return (${chatGPTConversationIdFromUrl.toString()})(location.href) === expected;
    };
    if (!validTarget()) return { submitted: false, reason: 'identity_or_expiry' };
    const editor = document.querySelector(
      '[data-composer-markdown][contenteditable="true"],#prompt-textarea,[data-testid="prompt-textarea"],' +
      '[data-testid="composer-input"],[contenteditable="true"][role="textbox"],' +
      '[contenteditable="true"][data-placeholder],textarea[placeholder]'
    );
    if (!(editor instanceof HTMLElement)) return { submitted: false, reason: 'editor_missing' };
    // No "reply is generating" refusal: ChatGPT accepts mid-reply sends (Steer).
    // Callers that must wait for idle (the T3 Session Queue) gate that themselves.
    let callback = null;
    // React sometimes puts the fiber on the editor and sometimes on its
    // wrappers. All paths still require the distinctive composer props.
    for (const root of [editor, editor.parentElement, editor.parentElement?.parentElement]) {
      const key = root && Object.keys(root).find(k => k.startsWith('__reactFiber'));
      let fiber = key && root[key];
      for (let depth = 0; fiber && depth < 90; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        const candidate = props?.onSubmit;
        if (typeof candidate === 'function' &&
            Object.prototype.hasOwnProperty.call(props, 'submitDisabled') &&
            Object.prototype.hasOwnProperty.call(props, 'allowBackgroundSubmit') &&
            typeof props.submitDisabled === 'boolean' &&
            (props.allowBackgroundSubmit === undefined ||
             typeof props.allowBackgroundSubmit === 'boolean')) {
          callback = candidate;
          break;
        }
      }
      if (callback) break;
    }
    if (!callback) return { submitted: false, reason: 'callback_unavailable' };
    if (!validTarget()) return { submitted: false, reason: 'identity_or_expiry' };
    // No DOM mutations. An error after this call begins is an UNKNOWN send.
    const result = callback(${JSON.stringify(input.text)}, performance.now(), { preserveDraft: true }, true);
    // Invocation is not proof of a user turn. React can report a rejected
    // submission even though its callback exists; keep that diagnostic.
    const outcome = value => ({ submitted: true,
      callbackOutcome: value === false ? 'rejected' : value === true ? 'accepted' : 'completed' });
    if (!result || typeof result.then !== 'function') return outcome(result);
    return Promise.race([
      Promise.resolve(result).then(outcome),
      new Promise(resolve => setTimeout(() => resolve({ submitted: true,
        callbackOutcome: 'pending' }), 1800)),
    ]);
  })()`;
}

/** Treat an unrecognized result or lost IPC response as ambiguous, not safe to retry. */
export function directSubmitOutcome(result: unknown): "submitted" | "not_submitted" {
  if (result && typeof result === "object" && "submitted" in result) {
    if (result.submitted === true) return "submitted";
    if (result.submitted === false) return "not_submitted";
  }
  throw new Error("Direct submit outcome unknown.");
}
