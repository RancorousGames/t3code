import { CHATGPT_ACTIVITY_EXPRESSION } from "./components/sidebar/chatGPTActivity";
import {
  inspectChatGPTPageSnapshot,
  type ChatGPTPageSnapshot,
} from "./chatGPTPageSnapshotInspection";

export const CHATGPT_BROWSER_FAILURE_GRACE_MS = 60_000;
export const CHATGPT_BROWSER_UNRESPONSIVE_ACTIVITY = "invalid: browser-unresponsive";
type BrowserFailure = "blank-page";
interface Observation {
  readonly url: string;
  readonly firstSeenAt: number;
  readonly failure: BrowserFailure;
  readonly confirmed: boolean;
}
const observations = new WeakMap<object, Observation>();

/** A sustained empty/near-empty guest is broken; a missing composer alone is not. */
export function isBlankChatGPTDocument(): boolean {
  const body = document.body;
  if (!body) return true;
  const visible = (element: Element) => element.getClientRects().length > 0;
  // A real chat, login/challenge flow, or interactive UI is not a blank page.
  if (
    Array.from(
      body.querySelectorAll(
        'input,textarea,button,[contenteditable="true"],[role="textbox"],iframe,canvas,img,video,' +
          '[data-message-author-role],[data-content-search-unit-key],[data-testid^="conversation-turn-"]',
      ),
    ).some(visible)
  )
    return false;
  const text = (body.innerText ?? body.textContent ?? "").replace(/\s+/g, " ").trim();
  if (/\b(?:sign in|log in|captcha|verify your identity|security check)\b/i.test(text))
    return false;
  // A spinner or bare ChatGPT logo/title can be all that a failed webview renders.
  return text.length <= 80;
}

export function chatGPTBrowserFailure(webview: { getURL?: () => string }): BrowserFailure | null {
  const observed = observations.get(webview);
  try {
    return observed?.confirmed && webview.getURL?.() === observed.url ? observed.failure : null;
  } catch {
    return null;
  }
}

/** Only a *visibly* blank guest is an error after a minute; inspection timeouts are unknown. */
export async function inspectChatGPTBrowserHealth(
  webview: {
    executeJavaScript: (expression: string) => Promise<unknown>;
    getURL?: () => string;
  },
  onSnapshot?: (snapshot: ChatGPTPageSnapshot) => void,
) {
  let url: string;
  try {
    url = webview.getURL?.() ?? "";
  } catch {
    return null; // Not attached, or navigating: no evidence of a failed browser.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      webview.executeJavaScript(`(() => {
        const activity = ${CHATGPT_ACTIVITY_EXPRESSION};
        return { blank: (${isBlankChatGPTDocument.toString()})(), activity,
          snapshot: (${inspectChatGPTPageSnapshot.toString()})(String(activity ?? "unknown")) };
      })()`),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 4_000);
      }),
    ]);
    if (webview.getURL?.() !== url) {
      observations.delete(webview);
      return null;
    }
    const probe = result as {
      blank?: boolean;
      activity?: unknown;
      snapshot?: ChatGPTPageSnapshot | null;
    } | null;
    // The guest URL must still match the returned snapshot. Never cache a
    // transient navigation/login page or assume a stale guest belongs to this session.
    if (probe?.snapshot && probe.snapshot.url === url) {
      try {
        onSnapshot?.(probe.snapshot);
      } catch {
        /* cache failure cannot affect health */
      }
    }
    const onChatGPT = new URL(url).origin === "https://chatgpt.com";
    // No DOM evidence was returned on timeout, so it cannot certify a blank guest.
    if (result === null) {
      observations.delete(webview);
      return "unknown: browser inspection timed out";
    }
    const failure = onChatGPT && probe?.blank === true ? "blank-page" : null;
    if (!failure) {
      observations.delete(webview);
      return typeof probe?.activity === "string" ? probe.activity : null;
    }
    const previous = observations.get(webview);
    const firstSeenAt =
      previous?.url === url && previous.failure === failure ? previous.firstSeenAt : Date.now();
    const confirmed = Date.now() - firstSeenAt >= CHATGPT_BROWSER_FAILURE_GRACE_MS;
    observations.set(webview, { url, firstSeenAt, failure, confirmed });
    return confirmed
      ? CHATGPT_BROWSER_UNRESPONSIVE_ACTIVITY
      : "unknown: checking browser responsiveness";
  } catch {
    observations.delete(webview);
    return null; // A navigation/detachment error is not a confirmed timeout.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
