// @effect-diagnostics globalTimers:off globalTimersInEffect:off globalErrorInEffectFailure:off preferSchemaOverJson:off -- Bounded native utility lifecycle and verified profile tuple.
/** On-demand same-profile native history search. A completely hidden utility
 * window (not a T3 session) is destroyed two minutes after its last request.
 * Never call private ChatGPT APIs: interact with the public UI and fail closed
 * when the UI cannot be recognized. */
import { BrowserWindow } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as PreviewManager from "../../preview/Manager.ts";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

type HistoryHit = { conversationId: string; title: string; url: string };
type Guest = { window: BrowserWindow; cleanup: ReturnType<typeof setTimeout> | null };
const guests = new Map<string, Guest>();
const ttlMs = 2 * 60_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let activeSearch: Promise<readonly HistoryHit[]> | null = null;

async function delay(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

/** Read the signed-in profile's recent sidebar links without navigating any user's live tab. */
async function recentInGuest(window: BrowserWindow): Promise<HistoryHit[]> {
  await window.loadURL("https://chatgpt.com/");
  if (window.isDestroyed()) throw new Error("ChatGPT recent-history guest closed.");
  let previous = "";
  for (let attempt = 0; attempt < 24; attempt++) {
    await delay(250);
    const observation = await window.webContents.executeJavaScript(`(() => {
      // ChatGPT has used aside, nav and unwrapped sidebar layouts.
      // Every link is separately verified against an assistant Bootstrap marker.
      const links = [...document.querySelectorAll('a[href*="/c/"]')].slice(0, 60)
        .map((link) => ({ url: link.href, title: (link.textContent || "").trim().slice(0, 200) }));
      const ready = links.length > 0 ||
        (document.readyState === "complete" &&
          Boolean(document.querySelector('aside, nav, [data-testid*="sidebar"]')));
      return { ready, links };
    })()`, false) as { ready: boolean; links: { url: string; title: string }[] };
    if (!observation.ready) continue;
    const valid = new Map<string, HistoryHit>();
    for (const link of observation.links) {
      try {
        const url = new URL(link.url);
        const match = /^(?:\/g\/[^/]+)?\/c\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
        if (url.hostname !== "chatgpt.com" || !match || !UUID.test(match[1]!) || !link.title) continue;
        const conversationId = match[1]!.toLowerCase();
        valid.set(conversationId, {
          conversationId, title: link.title, url: `https://chatgpt.com/c/${conversationId}`,
        });
      } catch { /* Ignore non-conversation links. */ }
    }
    const hits = [...valid.values()].slice(0, 20);
    const key = JSON.stringify(hits);
    if (hits.length && key === previous) return hits;
    if (!hits.length && attempt >= 12 && key === previous) return [];
    previous = key;
  }
  throw new Error("ChatGPT recent sidebar was not ready.");
}

async function searchInGuest(window: BrowserWindow, query: string): Promise<HistoryHit[]> {
  // Re-enter search from a known page for every request; the previous
  // search modal must not toggle closed when the button is clicked again.
  await window.loadURL("https://chatgpt.com/");
  if (window.isDestroyed()) throw new Error("ChatGPT search guest closed.");
  let activation = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    activation = await window.webContents.executeJavaScript(`(() => {
      const search = document.querySelector('[data-testid="search-button"]') ||
        document.querySelector('a[href="/search"]') ||
        [...document.querySelectorAll('button')].find((el) =>
          /^(search|search chats|search conversations)$/i.test(
            (el.getAttribute('aria-label') || el.textContent || '').trim(),
          ));
      if (!search) return false;
      search.click();
      return true;
    })()`, false) as boolean;
    if (activation) break;
    await delay(200);
  }
  if (!activation) throw new Error("ChatGPT history search button unavailable in this profile.");
  let inputReady = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    inputReady = await window.webContents.executeJavaScript(`(() => Boolean(
      document.querySelector('[role="dialog"] input[type="search"],[role="dialog"] input[placeholder*="Search"],[cmdk-input],[data-testid*="search"] input')
    ))()`, false) as boolean;
    if (inputReady) break;
    await delay(150);
  }
  if (!inputReady) throw new Error("ChatGPT history search input unavailable.");
  const expression = `(() => {
    const input = document.querySelector('[role="dialog"] input[type="search"],[role="dialog"] input[placeholder*="Search"],[cmdk-input],[data-testid*="search"] input');
    if (!(input instanceof HTMLInputElement)) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(query)} }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
  if (!(await window.webContents.executeJavaScript(expression, false)))
    throw new Error("ChatGPT history search input detached.");
  let lastResult = "";
  for (let attempt = 0; attempt < 24; attempt++) {
    await delay(250);
    const observation = await window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('[role="dialog"]') ||
        document.querySelector('[cmdk-root]') ||
        document.querySelector('[data-testid="search-results"]');
      if (!root) return { state: 'unavailable', hits: [] };
      const anchors = [...root.querySelectorAll('a[href*="/c/"]')];
      const hits = anchors.slice(0, 80).map((anchor) => ({
        url: anchor.href, title: (anchor.textContent || '').trim().slice(0, 200)
      }));
      const text = (root.textContent || '').slice(0, 3000);
      const noResults = /no (matching )?(results|conversations)|nothing found/i.test(text);
      return { state: hits.length ? 'results' : noResults ? 'empty' : 'loading', hits };
    })()`, false) as {state: string;hits:{url:string;title:string}[]};
    if (observation.state === "unavailable") throw new Error("ChatGPT history results UI unavailable.");
    if (observation.state === "empty") return [];
    if (observation.state !== "results") continue;
    const key = JSON.stringify(observation.hits);
    if (key !== lastResult) { lastResult = key; continue; }
    const hits = new Map<string, HistoryHit>();
    for (const hit of observation.hits) {
      try {
        const url = new URL(hit.url);
        const match = /^\/c\/([0-9a-f-]{36})\/?$/i.exec(url.pathname);
        if (url.hostname !== "chatgpt.com" || !match || !UUID.test(match[1]!) || !hit.title) continue;
        hits.set(match[1]!.toLowerCase(), {
          conversationId: match[1]!.toLowerCase(),
          url: `https://chatgpt.com/c/${match[1]!.toLowerCase()}`,
          title: hit.title,
        });
      } catch { /* An unknown anchor cannot become a result. */ }
    }
    if (hits.size) return [...hits.values()].slice(0, 50);
  }
  throw new Error("ChatGPT search returned no verifiable result DOM.");
}

/** Confirm an external Bootstrap ID in an assistant reply, never a title or user quote.
 * The utility is the only guest navigated; existing T3 browser tabs stay untouched. */
async function verifyBootstrapHit(window: BrowserWindow, hit: HistoryHit, markerId: string): Promise<boolean> {
  await window.loadURL(hit.url);
  if (window.isDestroyed()) return false;
  const expression = `(() => {
    const marker = "[T3_ID:" + "MARKER_REPLACE" + "]";
    const replies = document.querySelectorAll(
      '[data-message-author-role="assistant"],[data-content-search-unit-key$=":assistant"],[data-markdown-text-style="assistant-message"]'
    );
    return [...replies].some((node) => {
      if (node.closest('[data-message-author-role="user"],[data-content-search-unit-key$=":user"],[data-testid*="tool"]'))
        return false;
      const copy = node.cloneNode(true);
      copy.querySelectorAll('pre,code,blockquote,[hidden],[aria-hidden="true"],[data-testid*="tool"],button')
        .forEach((child) => child.remove());
      return copy.textContent?.toLowerCase().includes(marker.toLowerCase());
    });
  })()`.replace("MARKER_REPLACE", markerId);
  for (let attempt = 0; attempt < 24; attempt++) {
    await delay(250);
    if (await window.webContents.executeJavaScript(expression, false)) return true;
  }
  return false;
}

async function discoverBootstrapInGuest(
  window: BrowserWindow, markerId: string, conversationUrl?: string,
): Promise<HistoryHit[]> {
  if (conversationUrl) {
    const id = conversationUrl.slice("https://chatgpt.com/c/".length);
    const hit = { conversationId: id, url: conversationUrl, title: "Imported ChatGPT conversation" };
    return await verifyBootstrapHit(window, hit, markerId) ? [hit] : [];
  }
  // New phone chats tend to sync into Recents before full-text search indexes
  // their assistant replies. Search remains the fallback for older conversations.
  const errors: string[] = [];
  let inspected = 0;
  for (const [source, find] of [
    ["recent", () => recentInGuest(window)],
    ["search", () => searchInGuest(window, markerId)],
  ] as const) {
    let candidates: HistoryHit[];
    try { candidates = await find(); }
    catch (cause) {
      errors.push(`${source}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    for (const hit of candidates.slice(0, 12)) {
      inspected++;
      try {
        if (await verifyBootstrapHit(window, hit, markerId)) return [hit];
      } catch (cause) {
        errors.push(`${source} /c/${hit.conversationId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
  if (errors.length) throw new Error(
    `No verified Bootstrap marker in ${inspected} candidates (${errors.slice(0, 3).join("; ")}).`,
  );
  return [];
}

export const searchChatGPTHistoryIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CHATGPT_HISTORY_SEARCH_CHANNEL,
  payload: Schema.Struct({
    environmentId: Schema.String,
    profileId: Schema.optional(Schema.String),
    query: Schema.optional(Schema.String),
    mode: Schema.optional(Schema.Literals(["recent", "bootstrap"])),
    conversationUrl: Schema.optional(Schema.String),
  }),
  result: Schema.Array(Schema.Struct({
    conversationId: Schema.String,
    title: Schema.String,
    url: Schema.String,
  })),
  handler: Effect.fn("desktop.ipc.chatgpt.historySearch")(function* ({ environmentId, profileId, query, mode, conversationUrl }) {
    const term = (query ?? "").trim();
    if ((mode === "bootstrap" && !UUID.test(term)) ||
        (mode !== "recent" && (term.length < 2 || term.length > 150)) ||
        !environmentId || environmentId.length > 200 ||
        (conversationUrl !== undefined && (mode !== "bootstrap" ||
          !/^https:\/\/chatgpt\.com\/c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(conversationUrl))))
      return yield* Effect.fail(new Error("Invalid history search query, conversation URL or environment."));
    if (activeSearch) return yield* Effect.tryPromise(() => Promise.reject(new Error("ChatGPT history search already running.")));
    const manager = yield* PreviewManager.PreviewManager;
    const resolvedProfile = profileId || DEFAULT_BROWSER_PROFILE_ID;
    const scope = resolvedProfile === DEFAULT_BROWSER_PROFILE_ID
      ? environmentId : JSON.stringify([environmentId, resolvedProfile]);
    const persistent = resolvedProfile !== INCOGNITO_BROWSER_PROFILE_ID;
    const namespace = resolvedProfile === DEFAULT_BROWSER_PROFILE_ID ? undefined : "profile";
    yield* manager.getBrowserSession(scope, persistent, namespace);
    const partition = yield* manager.getBrowserPartition(scope, persistent, namespace);
    const key = partition;
    const guest = guests.get(key) ?? {
      window: new BrowserWindow({
        show: false,
        width: 900, height: 760,
        webPreferences: { partition, sandbox: true, nodeIntegration: false, contextIsolation: true },
      }),
      cleanup: null,
    };
    guests.set(key, guest);
    guest.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.window.webContents.on("will-navigate", (event, url) => {
      try {
        const hostname = new URL(url).hostname;
        if (hostname !== "chatgpt.com" && hostname !== "www.chatgpt.com") event.preventDefault();
      } catch { event.preventDefault(); }
    });
    if (guest.cleanup) clearTimeout(guest.cleanup);
    activeSearch = mode === "recent" ? recentInGuest(guest.window)
      : mode === "bootstrap" ? discoverBootstrapInGuest(guest.window, term, conversationUrl)
      : searchInGuest(guest.window, term);
    try {
      return yield* Effect.tryPromise(() => activeSearch!);
    } finally {
      activeSearch = null;
      guest.cleanup = setTimeout(() => {
        guests.delete(key);
        if (!guest.window.isDestroyed()) guest.window.destroy();
      }, ttlMs);
      guest.cleanup.unref();
    }
  }),
});
