import type { EnvironmentId } from "@t3tools/contracts";

import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { chatGPTWebviewAutomation } from "./chatGPTWebviewAutomation";
import {
  chatGPTBrowserThreadRef,
  chatGPTBrowserLastWorkingKey,
  type BrowserSession,
} from "./chatGPTBrowserSessions";
import { COMPOSER_SELECTOR } from "./chatGPTBrowserAutomation";
import { readThreadPreviewState } from "./previewStateStore";
import { previewBridge } from "./components/preview/previewBridge";
import { hasChatGPTLoadFailure } from "./components/sidebar/chatGPTConversationRecovery";
import {
  CHATGPT_ACTIVITY_EXPRESSION,
  chatGPTActivityAge,
  type ChatGPTActivityAge,
} from "./components/sidebar/chatGPTActivity";
import { inspectChatGPTPage, type PageInspection, type PageMessage } from "./chatGPTSessionDom";

export type ChatGPTSessionAction = "list" | "read" | "send" | "reload";
export type ChatGPTSessionWhich = "visible" | "recent" | "working" | "blocked" | "all";
export function matchesSessionWhich(
  which: ChatGPTSessionWhich,
  age: ChatGPTActivityAge,
  hidden: boolean,
): boolean {
  if (which === "all") return true;
  if (hidden) return false;
  if (which === "visible") return true;
  if (which === "recent") return age === "recent";
  if (which === "working") return age === "working";
  return age === "interrupted" || age === "invalid";
}
export type ChatGPTSessionStatus =
  | "working"
  | "waiting_for_input"
  | "done_or_idle"
  | "pending_or_stalled"
  | "stuck"
  | "stuck_connecting"
  | "loading"
  | "unavailable"
  | "new";

// First observed time is a local observation, not ChatGPT's disconnection time.
// Keep it until a later inspection shows recovery. Never assume the banner is permanent.
const interruptedFirstSeen = new Map<string, string>();

function guestFor(environmentId: EnvironmentId, sessionId: string) {
  const thread = chatGPTBrowserThreadRef(environmentId, sessionId);
  const state = readThreadPreviewState(thread);
  const tabId = state.activeTabId;
  const runtimeId =
    tabId && state.serverEpoch ? previewRuntimeTabId(thread, state.serverEpoch, tabId) : null;
  const webview = runtimeId
    ? Array.from(document.querySelectorAll("webview")).find(
        (el) => el.dataset.previewTab === runtimeId,
      )
    : null;
  return {
    runtimeId,
    webview,
    nav: tabId ? state.sessions[tabId]?.navStatus : null,
    loading: tabId ? state.desktopByTabId[tabId]?.loading : false,
  };
}

async function readGuest(
  environmentId: EnvironmentId,
  sessionId: string,
  from: "start" | "end",
  count: number,
  includeMessages: boolean,
  maxMessageChars = 6000,
): Promise<PageInspection | null> {
  const { webview } = guestFor(environmentId, sessionId);
  if (!webview) return null;
  const expression = `(() => {
    const result = (${inspectChatGPTPage.toString()})(${JSON.stringify({ from, count, includeMessages, maxMessageChars })});
    return { ...result, stuck: (${hasChatGPTLoadFailure.toString()})(),
      uiActivity: ${CHATGPT_ACTIVITY_EXPRESSION} };
  })()`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ChatGPT guest inspection timed out")), 4_000);
  });
  try {
    return await Promise.race([
      webview.executeJavaScript(expression) as Promise<PageInspection>,
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function inspectBrowserSession(
  environmentId: EnvironmentId,
  entry: BrowserSession,
  from: "start" | "end" = "end",
  count = 3,
  includeMessages = false,
  maxMessageChars = 6000,
) {
  const { runtimeId, nav, loading } = guestFor(environmentId, entry.id);
  const result = {
    id: entry.id,
    title: entry.title,
    hidden: entry.hidden === true,
    parentSessionId: entry.parentSessionId ?? null,
    project: entry.project ?? null,
    url: nav?._tag === "Success" ? nav.url : (null as string | null),
    status: "unavailable" as ChatGPTSessionStatus,
    statusReason: "" as string,
    statusObservedAt: new Date().toISOString(),
    connectionInterruptedFirstSeenAt: null as string | null,
    activity: "unknown" as PageInspection["activity"],
    uiColor: "unknown" as ChatGPTActivityAge,
    lastRole: null as PageInspection["lastRole"],
    lastText: "",
    totalTurns: 0,
    messages: [] as PageMessage[],
    lastWorkingAt: 0,
    diagnostics: undefined as PageInspection["diagnostics"],
  };
  try {
    result.lastWorkingAt =
      Number(
        JSON.parse(
          localStorage.getItem(chatGPTBrowserLastWorkingKey(environmentId, entry.id)) ?? "0",
        ),
      ) || 0;
  } catch {
    /* corrupt historical heartbeat */
  }
  if (entry.hidden) {
    interruptedFirstSeen.delete(entry.id);
    result.statusReason = "Session is hidden; restore it to attach its guest.";
    return result;
  }
  if (!runtimeId) {
    result.status = "loading";
    result.statusReason = "Preview tab has not attached yet.";
    return result;
  }
  if (loading) {
    result.status = "loading";
    result.statusReason = "Browser page is loading.";
    return result;
  }
  try {
    const page = await readGuest(
      environmentId,
      entry.id,
      from,
      count,
      includeMessages,
      maxMessageChars,
    );
    if (!page) {
      result.statusReason = "Embedded ChatGPT webview is not mounted.";
      return result;
    }
    result.url = page.url;
    result.activity = page.activity;
    result.lastRole = page.lastRole;
    result.lastText = page.lastText;
    result.totalTurns = page.totalTurns;
    result.messages = page.messages;
    result.diagnostics = page.diagnostics;
    // Match the sidebar icon exactly, including its 15-minute blue window,
    // rather than interpreting the transcript-based session status as a color.
    const uiState =
      page.uiActivity === "working" ||
      page.uiActivity === "idle" ||
      page.uiActivity === "interrupted"
        ? page.uiActivity
        : page.uiActivity?.startsWith("invalid: ")
          ? "invalid"
          : "unknown";
    result.uiColor = chatGPTActivityAge(uiState, result.lastWorkingAt, Date.now());
    // Time is sampled *after* the guest inspection, not at the start of a
    // potentially slow list scan. Both list and read report fresh observations.
    result.statusObservedAt = new Date().toISOString();
    if (page.connectionInterrupted && !page.stuck) {
      const firstSeen = interruptedFirstSeen.get(entry.id) ?? result.statusObservedAt;
      interruptedFirstSeen.set(entry.id, firstSeen);
      result.connectionInterruptedFirstSeenAt = firstSeen;
    } else {
      interruptedFirstSeen.delete(entry.id);
    }
    if (page.stuck) {
      result.status = "stuck";
      result.statusReason = "ChatGPT shows 'Could not load this ChatGPT conversation' and Retry.";
    } else if (page.connectionInterrupted) {
      result.status = "stuck_connecting";
      result.statusReason =
        "Stuck on connecting: ChatGPT shows 'Connection interrupted. Waiting for the complete answer'. " +
        "Reported at " +
        result.statusObservedAt +
        ". May reconnect on its own; if it persists, refresh the session.";
    } else if (page.activity === "working") {
      result.status = "working";
      result.statusReason = "A visible Stop generating control indicates active generation.";
    } else if (page.activity !== "idle") {
      result.status = "unavailable";
      result.statusReason =
        "ChatGPT composer not available; sign-in or transient navigation possible.";
    } else if (!page.totalTurns) {
      if (/\/c\/[^/]+/.test(page.url)) {
        result.status = "unavailable";
        result.statusReason =
          "Existing conversation URL, but no messages in the rendered DOM; cannot infer completion.";
      } else {
        result.status = "new";
        result.statusReason = "No messages yet.";
      }
    } else if (page.lastRole === "user") {
      result.status = "pending_or_stalled";
      result.statusReason = "Last visible message is from the user; generation is not running.";
    } else {
      // Question marks are only a weak hint. Distinguish it in the explanation.
      const looksLikeQuestion = /\?\s*$/.test(page.lastText.trim());
      result.status = looksLikeQuestion ? "waiting_for_input" : "done_or_idle";
      result.statusReason = looksLikeQuestion
        ? "Assistant's last visible text ends with a question (heuristic, not a confirmed block)."
        : "Assistant replied and generation stopped; completion cannot be confirmed from the DOM.";
    }
  } catch (error) {
    result.status = "unavailable";
    result.statusReason = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export async function runChatGPTSessionControl(input: {
  environmentId: EnvironmentId;
  sessions: readonly BrowserSession[];
  action: ChatGPTSessionAction;
  which?: ChatGPTSessionWhich | undefined;
  sessionId?: string | undefined;
  from?: "start" | "end" | undefined;
  count?: number | undefined;
  maxMessageChars?: number | undefined;
  message?: string | undefined;
  force?: boolean | undefined;
}): Promise<unknown> {
  const { environmentId, sessions, action } = input;
  const count = Math.max(1, Math.min(20, Math.floor(input.count ?? 3)));
  const from = input.from ?? "end";
  if (action === "list") {
    const which = input.which ?? "visible";
    // Hidden tabs are not mounted. Skip them for every filtered view and
    // never try to revive them just to determine their activity.
    const candidates = which === "all" ? sessions : sessions.filter((entry) => !entry.hidden);
    const inspected: Awaited<ReturnType<typeof inspectBrowserSession>>[] = [];
    for (let i = 0; i < candidates.length; i += 4) {
      inspected.push(
        ...(await Promise.all(
          candidates.slice(i, i + 4).map((entry) => inspectBrowserSession(environmentId, entry)),
        )),
      );
    }
    const result = inspected.filter((entry) =>
      matchesSessionWhich(which, entry.uiColor, entry.hidden),
    );
    return { which, sessions: result, total: result.length };
  }
  if (!input.sessionId) throw new Error("sessionId is required for read, send, and reload.");
  const entry = sessions.find((session) => session.id === input.sessionId);
  if (!entry) throw new Error("Unknown ChatGPT session id.");
  if (entry.hidden) throw new Error("Session is hidden; restore it before controlling it.");
  if (action === "read") {
    const maxMessageChars = Number.isFinite(input.maxMessageChars)
      ? Math.max(1, Math.min(24_000, Math.floor(input.maxMessageChars!)))
      : 6000;
    const session = await inspectBrowserSession(
      environmentId,
      entry,
      from,
      count,
      true,
      maxMessageChars,
    );
    return { session, selection: { from, count } };
  }
  if (action === "reload") {
    const before = await inspectBrowserSession(environmentId, entry);
    if (before.status === "working") throw new Error("Refusing to reload a working session.");
    if (before.status !== "stuck" && before.status !== "stuck_connecting" && !input.force)
      throw new Error("Session is not confirmed stuck; pass force=true to reload it anyway.");
    // The connection may have recovered between calls. Verify once more before
    // refreshing, particularly for the transient interrupted-connection banner.
    if (before.status === "stuck_connecting") {
      const latest = await inspectBrowserSession(environmentId, entry);
      if (latest.status !== "stuck_connecting" && latest.status !== "stuck" && !input.force)
        throw new Error("Session recovered or changed state before refresh; not reloading.");
      if (latest.status === "working") throw new Error("Refusing to reload a working session.");
    }
    const { runtimeId } = guestFor(environmentId, entry.id);
    if (!runtimeId || !previewBridge) throw new Error("ChatGPT guest is not attached.");
    await previewBridge.refresh(runtimeId);
    return { sessionId: entry.id, reloaded: true, previousStatus: before.status };
  }
  if (action === "send") {
    const message = input.message?.trim();
    if (!message) throw new Error("Non-empty message required.");
    const before = await inspectBrowserSession(environmentId, entry, "end", 1, true);
    if (
      before.status === "working" ||
      before.status === "stuck" ||
      before.status === "stuck_connecting" ||
      before.status === "unavailable" ||
      before.status === "loading"
    )
      throw new Error(`Cannot send while session is ${before.status}: ${before.statusReason}`);
    const { runtimeId } = guestFor(environmentId, entry.id);
    if (!runtimeId) throw new Error("ChatGPT guest is not attached.");
    const inputExpression = `(() => {const el=document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
      return el instanceof HTMLTextAreaElement ? el.value :
        el instanceof HTMLElement ? (el.innerText||el.textContent||"") : null;})()`;
    const draft = await chatGPTWebviewAutomation.evaluate(runtimeId, {
      expression: inputExpression,
    });
    if (typeof draft === "string" && draft.trim())
      throw new Error("Composer contains an existing draft; refusing to overwrite it.");
    await chatGPTWebviewAutomation.waitFor(runtimeId, {
      selector: COMPOSER_SELECTOR,
      timeoutMs: 3000,
    });
    await chatGPTWebviewAutomation.type(runtimeId, {
      selector: COMPOSER_SELECTOR,
      text: message,
      clear: true,
    });
    // Once Send is clicked, do not retry: duplicate prompts can be costly.
    await chatGPTWebviewAutomation.press(runtimeId, { key: "Enter" });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const after = await readGuest(environmentId, entry.id, "end", 1, true);
        const userMessages = after?.messages.filter((m) => m.role === "user") ?? [];
        if (
          userMessages.some((m) => m.text.trim() === message) &&
          (after?.totalTurns ?? 0) > before.totalTurns
        )
          return { sessionId: entry.id, messageSent: true };
      } catch {
        /* navigation */
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      "Send was invoked but ChatGPT did not confirm the new user turn. Do not retry blindly.",
    );
  }
  throw new Error("Unsupported action.");
}
