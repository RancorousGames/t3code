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

async function searchInGuest(window: BrowserWindow, query: string): Promise<HistoryHit[]> {
  // Re-enter search from a known page for every request; the previous
  // search modal must not toggle closed when the button is clicked again.
  await window.loadURL("https://chatgpt.com/");
  if (window.isDestroyed()) throw new Error("ChatGPT search guest closed.");
  const activation = await window.webContents.executeJavaScript(`(() => {
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
  if (!activation) throw new Error("ChatGPT history search UI unavailable.");
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

export const searchChatGPTHistoryIpc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CHATGPT_HISTORY_SEARCH_CHANNEL,
  payload: Schema.Struct({
    environmentId: Schema.String,
    profileId: Schema.optional(Schema.String),
    query: Schema.String,
  }),
  result: Schema.Array(Schema.Struct({
    conversationId: Schema.String,
    title: Schema.String,
    url: Schema.String,
  })),
  handler: Effect.fn("desktop.ipc.chatgpt.historySearch")(function* ({ environmentId, profileId, query }) {
    const term = query.trim();
    if (term.length < 2 || term.length > 150 || !environmentId || environmentId.length > 200)
      return yield* Effect.fail(new Error("Invalid history search query or environment."));
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
    activeSearch = searchInGuest(guest.window, term);
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
