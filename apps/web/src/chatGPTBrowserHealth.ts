import { CHATGPT_ACTIVITY_EXPRESSION } from "./components/sidebar/chatGPTActivity";

export const CHATGPT_BROWSER_FAILURE_GRACE_MS = 60_000;
export const CHATGPT_BROWSER_UNRESPONSIVE_ACTIVITY = "invalid: browser-unresponsive";
type BrowserFailure = "blank-page" | "probe-timeout";
interface Observation {
  readonly url: string;
  readonly firstSeenAt: number;
  readonly failure: BrowserFailure;
  readonly confirmed: boolean;
}
const observations = new WeakMap<object, Observation>();

/** Runs inside the guest. Controls/media exclude sparse login and challenge pages. */
export function isBlankChatGPTDocument(): boolean {
  const body = document.body;
  if (!body || (body.innerText ?? body.textContent)?.trim()) return false;
  return !Array.from(
    body.querySelectorAll('input,textarea,button,[contenteditable="true"],iframe,canvas,svg,img,video,[role="progressbar"]'),
  ).some((element) => element.getClientRects().length > 0);
}

export function chatGPTBrowserFailure(webview: { getURL?: () => string }): BrowserFailure | null {
  const observed = observations.get(webview);
  try {
    return observed?.confirmed && webview.getURL?.() === observed.url ? observed.failure : null;
  } catch {
    return null;
  }
}

/** A timeout alone is initially unknown; require the same guest/URL for a minute. */
export async function inspectChatGPTBrowserHealth(webview: {
  executeJavaScript: (expression: string) => Promise<unknown>;
  getURL?: () => string;
}) {
  let url: string;
  try {
    url = webview.getURL?.() ?? "";
  } catch {
    return null; // Not attached, or navigating: no evidence of a failed browser.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      webview.executeJavaScript(`(() => ({blank: (${isBlankChatGPTDocument.toString()})(), activity: ${CHATGPT_ACTIVITY_EXPRESSION}}))()`),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 4_000);
      }),
    ]);
    if (webview.getURL?.() !== url) {
      observations.delete(webview);
      return null;
    }
    const probe = result as { blank?: boolean; activity?: unknown } | null;
    const onChatGPT = new URL(url).origin === "https://chatgpt.com";
    const failure = !onChatGPT ? null : result === null ? "probe-timeout" : probe?.blank === true ? "blank-page" : null;
    if (!failure) {
      observations.delete(webview);
      return typeof probe?.activity === "string" ? probe.activity : null;
    }
    const previous = observations.get(webview);
    const firstSeenAt = previous?.url === url && previous.failure === failure
      ? previous.firstSeenAt : Date.now();
    const confirmed = Date.now() - firstSeenAt >= CHATGPT_BROWSER_FAILURE_GRACE_MS;
    observations.set(webview, { url, firstSeenAt, failure, confirmed });
    return confirmed ? CHATGPT_BROWSER_UNRESPONSIVE_ACTIVITY : "unknown: checking browser responsiveness";
  } catch {
    observations.delete(webview);
    return null; // A navigation/detachment error is not a confirmed timeout.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
