import type { EnvironmentId } from "@t3tools/contracts";

import {
  isChatGPTGuestHibernated,
  touchChatGPTGuest,
  wakeChatGPTGuest,
} from "./browser/chatGPTGuestHibernation";
import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { resetHostedBrowserGuest } from "./browser/hostedBrowserGuestReset";
import { chatGPTBrowserFailure } from "./chatGPTBrowserHealth";
import {
  hasDurableUnknownChatGPTSend,
  reserveDurableUnknownChatGPTSend,
  releaseDurableUnknownChatGPTSend,
  clearDurableUnknownChatGPTSendsForTests,
  readDurableUnknownChatGPTSend,
  archiveLegacyUnknownChatGPTSend,
  type DurableChatGPTSend,
} from "./chatGPTUncertainSendFence";
import { chatGPTWebviewAutomation } from "./chatGPTWebviewAutomation";
import {
  chatGPTBrowserThreadRef,
  chatGPTBrowserLastWorkingKey,
  chatGPTBrowserLastUrlKey,
  type BrowserSession,
} from "./chatGPTBrowserSessions";
import { COMPOSER_SELECTOR } from "./chatGPTBrowserAutomation";
import {
  CHATGPT_COMPOSER_PROBE_EXPRESSION,
  hasVerifiedEmptyChatGPTComposer,
  sameComposerProbe,
  inspectChatGPTComposer,
  type ComposerProbe,
} from "./chatGPTDraftInspection";
import { readThreadPreviewState } from "./previewStateStore";
import { previewBridge } from "./components/preview/previewBridge";
import {
  hasChatGPTLoadFailure,
  recordRecoveryAttempt,
} from "./components/sidebar/chatGPTConversationRecovery";
import {
  CHATGPT_ACTIVITY_EXPRESSION,
  chatGPTActivityAge,
  type ChatGPTActivityAge,
} from "./components/sidebar/chatGPTActivity";
import {
  CHATGPT_SAFE_EMPTY_HOME_EXPRESSION,
  inspectChatGPTPage,
  type PageInspection,
  type PageMessage,
} from "./chatGPTSessionDom";
import { isChatGPTHomeUrl } from "./chatGPTBrowserPrewarm";
import {
  appendUnverifiedOpenRigPolicies,
  prepareChatGPTSessionMessage,
} from "./chatGPTSessionMessaging";
import {
  CANONICAL_CHATGPT_CONVERSATION_ID,
  chatGPTConversationIdFromUrl,
  requireExpectedChatGPTConversation,
} from "./chatGPTConversationIdentity";
import {
  readChatGPTRecoveryEvents,
  readChatGPTRecoveryState,
  recordChatGPTRecoveryEvent,
} from "./chatGPTRecoveryDiagnostics";
import { recordChatGPTSessionRefreshedAt } from "./chatGPTSessionTimestamps";
import { tryAcquireChatGPTRecoveryMutation } from "./chatGPTRecoveryMutationGate";
import { validChatGPTCompletion } from "./chatGPTSessionCompletion";
import { assertArchivableSession, descendantSessions } from "./chatGPTSessionArchivePolicy";

export type ChatGPTSessionAction =
  | "list"
  | "snapshot"
  | "read"
  | "send"
  | "reconcile_send"
  | "reload"
  | "complete"
  | "archive"
  | "restore"
  | "change_state";
export type ChatGPTSessionWhich = "visible" | "recent" | "working" | "blocked" | "all";
export const reloadRequiresForce = (color: ChatGPTActivityAge): boolean =>
  color === "interrupted" || color === "delivery-timeout";
export function matchesSessionWhich(
  which: ChatGPTSessionWhich,
  age: ChatGPTActivityAge,
  hidden: boolean,
): boolean {
  if (hidden) return false;
  if (which === "all") return true;
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
  | "conversation_full"
  | "loading"
  | "unavailable"
  | "hibernated"
  | "new";

// Browser-renderer-local receipt ledger. Keep uncertain attempts across subsequent
// socket calls so the same prompt is never clicked twice after a lost DOM ack.
// Restore the same evidence after restart; a retry must reconcile, never resend.
type PendingChatGPTSend = DurableChatGPTSend;
const uncertainChatGPTSends = new Map<string, PendingChatGPTSend>();
function pendingChatGPTSend(environmentId: EnvironmentId, sessionId: string) {
  const key = sendReceiptKey(environmentId, sessionId);
  let pending = uncertainChatGPTSends.get(key);
  if (!pending) {
    pending = readDurableUnknownChatGPTSend(environmentId, sessionId)?.attempt;
    if (pending) uncertainChatGPTSends.set(key, pending);
  }
  return pending;
}
/** Isolate disposable renderer fixtures; never callable in production. */
export function resetUncertainChatGPTSendsForTests(preserveDurable = false): void {
  if (import.meta.env.MODE !== "test") throw new Error("Test-only reset refused.");
  uncertainChatGPTSends.clear();
  if (!preserveDurable) clearDurableUnknownChatGPTSendsForTests();
}
// Explicitly duplicate-safe *temporary machine prompt*, not general user or
// OpenRig policy-enriched messages. Validate the entire fixed body and UUID.
const GENERIC_WAKE =
  /^\[AUTOMATED TEMPORARY OMNIHUB KEEP-AWAKE; not a human message\] If you have already been assigned work that is still authorized and unfinished, please resume it and report meaningful progress or blockers\. If you are blocked on a human decision, finished, or awaiting input, do not invent work; state that fact\. This monitor is a temporary bootstrap to be replaced by OpenRig's canonical scheduler\. \[Monitor attempt: [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\]$/;
export function isDuplicateSafeGenericWake(message: string): boolean {
  return GENERIC_WAKE.test(message);
}
export function canReplaceGenericUnknown(
  pending: Pick<PendingChatGPTSend, "original" | "text"> | null,
  next: string,
): boolean {
  return (
    !!pending &&
    pending.text === pending.original &&
    isDuplicateSafeGenericWake(pending.original) &&
    isDuplicateSafeGenericWake(next) &&
    pending.original !== next
  );
}

/** After the prior generation's UNKNOWN evidence is durably archived, let
 * the newly rebooted conversation establish independent send receipts. */
export function markChatGPTRebootGeneration(environmentId: EnvironmentId, sessionId: string): void {
  uncertainChatGPTSends.delete(sendReceiptKey(environmentId, sessionId));
}

/** Synchronous, non-consuming guard: an unknown send needs its guest for reconciliation. */
export function hasUncertainChatGPTSend(environmentId: EnvironmentId, sessionId: string): boolean {
  return (
    uncertainChatGPTSends.has(sendReceiptKey(environmentId, sessionId)) ||
    hasDurableUnknownChatGPTSend(environmentId, sessionId)
  );
}

/**
 * Recover a hibernated predecessor INSIDE its existing preview/browser slot.
 * Unloading is normal: do not create a second browser or replace the guest.
 * A transient inspection timeout is not proof that the old conversation is lost.
 * No destructive reload/reset is permitted until its draft is verified and
 * privately backed up by assertChatGPTRebootSafe().
 */
export async function wakeChatGPTRebootPredecessor(
  environmentId: EnvironmentId,
  session: BrowserSession,
  conversationId: string,
  timeoutMs = 45_000,
): Promise<void> {
  if (session.hidden) throw new Error("Hidden reboot predecessor must be restored first.");
  const original = guestFor(environmentId, session.id);
  if (!original.runtimeId) {
    throw new Error(
      "Original browser preview is not attached yet; recover its existing preview before rebooting.",
    );
  }
  const persistedUrl = (() => {
    try {
      return JSON.parse(
        window.localStorage.getItem(chatGPTBrowserLastUrlKey(environmentId, session.id)) ?? "null",
      ) as unknown;
    } catch {
      return null;
    }
  })();
  const known = original.nav?._tag === "Success" ? original.nav.url : persistedUrl;
  if (chatGPTConversationIdFromUrl(typeof known === "string" ? known : null) !== conversationId) {
    throw new Error(
      "Saved predecessor conversation differs; refresh would replace unknown history.",
    );
  }
  // A wake only mounts an unloaded guest. It does not navigate/reload an
  // already-mounted document, so drafts and uncertain sends remain untouched.
  wakeChatGPTGuest(original.runtimeId);
  touchChatGPTGuest(original.runtimeId);
  const deadline = Date.now() + timeoutMs;
  do {
    const guest = guestFor(environmentId, session.id);
    if (guest.runtimeId !== original.runtimeId)
      throw new Error("Existing browser runtime changed during reboot recovery.");
    if (isLoadedChatGPTBrowserGuest(environmentId, session)) {
      try {
        const observed = await readGuest(environmentId, session.id, "end", 1, false);
        if (observed && chatGPTConversationIdFromUrl(observed.url) !== conversationId) {
          throw new Error(
            "Recovered guest contains a different conversation; preserve its contents.",
          );
        }
        if (
          observed?.conversationFull === true &&
          chatGPTConversationIdFromUrl(observed.url) === conversationId
        )
          return; // The permanent limit page may have no composer, but is a loaded predecessor.
        if (observed?.activity === "idle" && !observed.stuck && !observed.connectionInterrupted)
          return;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Recovered guest contains"))
          throw error;
        // ChatGPT may be throttled or still hydrating; keep the same browser.
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  } while (true);
  throw new Error(
    "Predecessor is still recovering in its existing browser; refresh has not navigated or sent.",
  );
}

/** Same-container navigation requires a private backed-up empty draft and no
 * active generation. A stalled last user turn can be replaced too; requiring
 * an assistant reply would prevent recovery of precisely that conversation.
 * Wake is performed before this guard. */
export async function assertChatGPTRebootSafe(
  environmentId: EnvironmentId,
  session: BrowserSession,
  conversationId: string | null,
): Promise<string> {
  if (
    !isLoadedChatGPTBrowserGuest(environmentId, session) ||
    hasUncertainChatGPTSend(environmentId, session.id)
  )
    throw new Error("Agent reboot requires a loaded guest without UNKNOWN sends.");
  const original = guestFor(environmentId, session.id);
  const snapshot = (await runChatGPTSessionControl({
    environmentId,
    sessions: [session],
    action: "snapshot",
    sessionId: session.id,
  })) as { status?: string; uncertainSendPresent?: boolean };
  if (snapshot.status !== "backed_up_empty" || snapshot.uncertainSendPresent === true)
    throw new Error("Agent reboot requires a verified empty private draft backup.");
  const page = await readGuest(environmentId, session.id, "end", 1, false);
  const probe = (await original.webview!.executeJavaScript(
    CHATGPT_COMPOSER_PROBE_EXPRESSION,
  )) as ComposerProbe;
  if (
    !page ||
    (page.activity !== "idle" && !page.conversationFull) ||
    page.stuck ||
    page.connectionInterrupted ||
    (conversationId
      ? chatGPTConversationIdFromUrl(page.url) !== conversationId
      : !isChatGPTHomeUrl(page.url) || page.totalTurns !== 0) ||
    !(probe.status === "empty" || (page.conversationFull === true && probe.status === "unknown")) ||
    probe.url !== page.url ||
    hasUncertainChatGPTSend(environmentId, session.id) ||
    guestFor(environmentId, session.id).webview !== original.webview ||
    !isLoadedChatGPTBrowserGuest(environmentId, session)
  )
    throw new Error("Guest, conversation, generation or draft changed before reboot.");
  return original.runtimeId!;
}

/** Last generation/composer guard and navigation execute in one guest task so
 * a newly started assistant or newly typed draft cannot be lost between them. */
export async function navigateChatGPTRebootSafe(
  environmentId: EnvironmentId,
  session: BrowserSession,
  runtimeId: string,
  conversationId: string | null,
  url: string,
): Promise<void> {
  const guest = guestFor(environmentId, session.id);
  if (
    guest.runtimeId !== runtimeId ||
    !guest.webview ||
    !isLoadedChatGPTBrowserGuest(environmentId, session) ||
    hasUncertainChatGPTSend(environmentId, session.id)
  )
    throw new Error("Refresh runtime or UNKNOWN send changed before navigation.");
  const result = await guest.webview.executeJavaScript(`(() => {
    const page = (${inspectChatGPTPage.toString()})({from:'end',count:1,includeMessages:false});
    const draft = (${inspectChatGPTComposer.toString()})(document, location.href);
    const limitWithoutEditor = page.conversationFull === true && draft.status === 'unknown' &&
      !document.querySelector('textarea,[contenteditable="true"]');
    const expected = ${JSON.stringify(conversationId)};
    const current = /^\\/c\\/([a-f0-9-]{36})(?:\\/|$)/i.exec(location.pathname)?.[1] ?? null;
    const home = location.hostname === 'chatgpt.com' && location.pathname === '/';
    if (!(draft.status === 'empty' || limitWithoutEditor) ||
        (page.activity !== 'idle' && !limitWithoutEditor) || page.stuck || page.connectionInterrupted ||
        (${hasChatGPTLoadFailure.toString()})() ||
        (expected ? current !== expected :
          (!home || page.totalTurns !== 0))) return false;
    location.assign(${JSON.stringify(url)});
    return true;
  })()`);
  if (result !== true)
    throw new Error("Guest declined reboot navigation; preserve its current conversation.");
}

function sendReceiptKey(environmentId: EnvironmentId, sessionId: string): string {
  return `${environmentId}:${sessionId}`;
}

async function reconcileChatGPTSend(
  environmentId: EnvironmentId,
  sessionId: string,
  runtimeId: string,
  attempt: PendingChatGPTSend,
): Promise<boolean> {
  const after = await readGuest(environmentId, sessionId, "end", 1, true);
  if (
    !after ||
    after.url !== attempt.url ||
    guestFor(environmentId, sessionId).runtimeId !== runtimeId
  )
    return false;
  const newKey =
    !!after.lastUserTurnKey && after.lastUserTurnKey !== attempt.before.lastUserTurnKey;
  const newTurn = after.totalTurns > attempt.before.totalTurns;
  if (!newKey && !newTurn) return false;
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  if (
    after.messages.some(
      (item) => item.role === "user" && normalize(item.text) === normalize(attempt.text),
    )
  )
    return true;
  // A turn's DOM projection may truncate at 6k or include wrapper controls.
  // Require the new turn identity *and* the complete guest user text.
  const fullText = await chatGPTWebviewAutomation.evaluate(runtimeId, {
    expression: `(() => {
      const nodes = document.querySelectorAll('[data-message-author-role="user"],[data-content-search-unit-key$=":user"]');
      const last = nodes[nodes.length - 1];
      return last ? (last.innerText || last.textContent || "") : null;
    })()`,
  });
  return typeof fullText === "string" && normalize(fullText) === normalize(attempt.text);
}

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

/** Provider v1 only touches already mounted, awake guests; never hydrates tabs. */
export function isLoadedChatGPTBrowserGuest(
  environmentId: EnvironmentId,
  entry: BrowserSession,
): boolean {
  if (entry.hidden) return false;
  const guest = guestFor(environmentId, entry.id);
  return (
    !!guest.runtimeId &&
    !!guest.webview &&
    guest.nav?._tag === "Success" &&
    !guest.loading &&
    !isChatGPTGuestHibernated(guest.runtimeId)
  );
}

const GUEST_WAKE_TIMEOUT_MS = 45_000;

/** Reloads a hibernated guest and waits until its composer can be inspected. */
async function ensureGuestAwake(environmentId: EnvironmentId, sessionId: string): Promise<void> {
  const { runtimeId } = guestFor(environmentId, sessionId);
  if (!runtimeId) return;
  if (!isChatGPTGuestHibernated(runtimeId)) {
    touchChatGPTGuest(runtimeId);
    return;
  }
  wakeChatGPTGuest(runtimeId);
  const deadline = Date.now() + GUEST_WAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const guest = guestFor(environmentId, sessionId);
    if (guest.webview && !guest.loading && guest.nav?._tag === "Success") {
      try {
        const page = await readGuest(environmentId, sessionId, "end", 1, false);
        if (page && (page.activity !== "unknown" || page.stuck)) return;
      } catch {
        /* still hydrating */
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  // Fall through: the caller's inspection reports the actual state.
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
    url:
      entry.hidden && entry.archive && !entry.archive.restoredAt
        ? entry.archive.conversationUrl
        : nav?._tag === "Success"
          ? nav.url
          : (null as string | null),
    conversationId: chatGPTConversationIdFromUrl(
      entry.hidden && entry.archive && !entry.archive.restoredAt
        ? entry.archive.conversationUrl
        : nav?._tag === "Success"
          ? nav.url
          : null,
    ),
    archive: entry.archive ?? null,
    observedGuestUrl: null as string | null,
    status: "unavailable" as ChatGPTSessionStatus,
    statusReason: "" as string,
    recoveryProblem: null as "browser-unresponsive" | null,
    conversationFull: false,
    statusObservedAt: new Date().toISOString(),
    connectionInterruptedFirstSeenAt: null as string | null,
    activity: "unknown" as PageInspection["activity"],
    uiColor: "unknown" as ChatGPTActivityAge,
    lastRole: null as PageInspection["lastRole"],
    lastUserTurnKey: null as string | null,
    lastUserTurn: null as number | null,
    lastText: "",
    latestMessageFirstFiveWords: null as string | null,
    totalTurns: 0,
    messages: [] as PageMessage[],
    lastWorkingAt: 0,
    diagnostics: undefined as PageInspection["diagnostics"],
    completion: null as BrowserSession["completion"] | null,
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
  if (isChatGPTGuestHibernated(runtimeId)) {
    result.status = "hibernated";
    result.statusReason =
      "Unloaded after inactivity to save memory; read, send, reload or complete reloads it.";
    result.activity = "idle";
    result.uiColor = chatGPTActivityAge("idle", result.lastWorkingAt, Date.now());
    return result;
  }
  const attached = guestFor(environmentId, entry.id).webview;
  if (attached && chatGPTBrowserFailure(attached)) {
    result.recoveryProblem = "browser-unresponsive";
    result.uiColor = "invalid";
    result.statusReason = `Browser instance is blank or unresponsive (${chatGPTBrowserFailure(attached)}).`;
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
    result.observedGuestUrl = page.url;
    result.conversationId = chatGPTConversationIdFromUrl(page.url);
    result.completion = validChatGPTCompletion(
      entry.completion,
      page.url,
      page.totalTurns,
      page.activity === "idle" && !page.stuck && !page.connectionInterrupted,
    );
    result.activity = page.activity;
    result.conversationFull = page.conversationFull === true;
    result.lastRole = page.lastRole;
    result.lastUserTurnKey = page.lastUserTurnKey;
    result.lastUserTurn = page.lastUserTurn;
    result.lastText = page.lastText;
    result.latestMessageFirstFiveWords = page.latestMessageFirstFiveWords ?? null;
    result.totalTurns = page.totalTurns;
    result.messages = page.messages;
    result.diagnostics = page.diagnostics;
    // Match the sidebar icon exactly, including its 15-minute blue window,
    // rather than interpreting the transcript-based session status as a color.
    const uiState =
      page.uiActivity === "working" ||
      page.uiActivity === "idle" ||
      page.uiActivity === "delivery-timeout" ||
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
    if (page.conversationFull && page.activity !== "working") {
      result.status = "conversation_full";
      result.statusReason =
        "ChatGPT confirmed its conversation length limit; this thread cannot accept further turns.";
    } else if (page.stuck) {
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
      if (result.conversationId) {
        result.status = "unavailable";
        result.statusReason =
          "Existing conversation URL, but no messages in the rendered DOM; cannot infer completion.";
      } else {
        result.status = "new";
        result.statusReason = "No messages yet.";
      }
    } else if (page.lastRole === "user" || !page.assistantHasContent) {
      result.status = "pending_or_stalled";
      result.statusReason =
        page.lastRole === "user"
          ? "User turn is visible, but there is no active Stop control or assistant reply. Delivery is observable; assistant processing/completion is unknown."
          : "Assistant placeholder is empty and no Stop control is active; a reply or completion has NOT been observed.";
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
  includeHidden?: boolean | undefined;
  state?: "hidden" | "unhidden" | "closed" | undefined;
  sessionId?: string | undefined;
  from?: "start" | "end" | undefined;
  count?: number | undefined;
  maxMessageChars?: number | undefined;
  message?: string | undefined;
  senderSessionId?: string | undefined;
  expectedConversationId?: string | undefined;
  /** Provider bridge only: refuse hibernated/unmounted guests instead of waking them. */
  neverWake?: boolean | undefined;
  force?: boolean | undefined;
  managerDecision?: boolean | undefined;
  reason?: string | undefined;
  /** Local selected-session recovery only. Never exposed over the desktop pipe. */
  shouldContinue?: (() => boolean) | undefined;
}): Promise<unknown> {
  const { environmentId, sessions, action } = input;
  const count = Math.max(1, Math.min(20, Math.floor(input.count ?? 3)));
  const from = input.from ?? "end";
  if (
    input.expectedConversationId !== undefined &&
    !["read", "send", "reconcile_send"].includes(action)
  ) {
    throw new Error("expectedConversationId is supported only for read, send and reconcile_send.");
  }
  if (action === "list") {
    const which = input.which ?? "visible";
    // "all" changes activity filtering, never the hidden-session privacy default.
    // Hidden guests stay unmounted and are never woken merely to list them.
    const candidates =
      input.includeHidden === true ? sessions : sessions.filter((entry) => !entry.hidden);
    const inspected: Awaited<ReturnType<typeof inspectBrowserSession>>[] = [];
    for (let i = 0; i < candidates.length; i += 4) {
      inspected.push(
        ...(await Promise.all(
          candidates.slice(i, i + 4).map((entry) => inspectBrowserSession(environmentId, entry)),
        )),
      );
    }
    const result = inspected.filter(
      (entry) =>
        (input.includeHidden === true && entry.hidden) ||
        matchesSessionWhich(which, entry.uiColor, entry.hidden),
    );
    return { which, sessions: result, total: result.length };
  }
  if (!input.sessionId)
    throw new Error(
      "sessionId is required for snapshot, read, send, reload, complete, archive, restore and change_state.",
    );
  const entry = sessions.find((session) => session.id === input.sessionId);
  if (!entry) throw new Error("Unknown ChatGPT session id.");
  if (action === "snapshot") {
    // Do NOT call ensureGuestAwake, inspectBrowserSession, or read: each has
    // hydration/reconciliation side effects. This is an exact loaded-guest-only read.
    const receiptKey = sendReceiptKey(environmentId, entry.id);
    const pending = uncertainChatGPTSends.get(receiptKey) ?? null;
    const persistedUnknown = hasDurableUnknownChatGPTSend(environmentId, entry.id);
    const pendingRevision = pending ? JSON.stringify(pending) : null;
    const ledgerUnchanged = () => {
      const current = uncertainChatGPTSends.get(receiptKey) ?? null;
      return current === pending && (current ? JSON.stringify(current) : null) === pendingRevision;
    };
    const unknown = (reason: string) => ({
      sessionId: entry.id,
      status: "UNKNOWN" as const,
      reason,
      uncertainSendPresent: pending !== null || persistedUnknown,
    });
    if (entry.hidden) return unknown("hidden_guest");
    const guest = guestFor(environmentId, entry.id);
    if (!guest.runtimeId || !guest.webview || isChatGPTGuestHibernated(guest.runtimeId))
      return unknown("hibernated_or_unmounted");
    if (guest.loading || guest.nav?._tag !== "Success") return unknown("guest_not_ready");
    const read = async (): Promise<ComposerProbe> =>
      (await guest.webview!.executeJavaScript(CHATGPT_COMPOSER_PROBE_EXPRESSION)) as ComposerProbe;
    let first: ComposerProbe;
    let second: ComposerProbe;
    try {
      first = await read();
      second = await read();
    } catch {
      return unknown("guest_read_failed");
    }
    // ChatGPT's hard-limit panel can remove the composer entirely. In that
    // specific state there is no DOM editor to hold an unsent draft. Prove
    // the terminal notice, exact URL, missing ALL editors and no Stop control
    // immediately before saving an empty private draft receipt.
    let confirmedLimitWithoutEditor = false;
    if (first.status === "unknown" && second.status === "unknown" && first.url === second.url) {
      try {
        confirmedLimitWithoutEditor =
          (await guest.webview.executeJavaScript(`(() => {
          const page = (${inspectChatGPTPage.toString()})({from:'end',count:1,includeMessages:false});
          const stop = document.querySelector('button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating"]');
          return page.conversationFull === true && page.url === ${JSON.stringify(guest.nav.url)} &&
            !document.querySelector('textarea,[contenteditable="true"]') &&
            !(stop && stop.getClientRects().length && !stop.hasAttribute('disabled'));
        })()`)) === true;
      } catch {
        /* Unknown cannot authorize a refresh. */
      }
    }
    if (
      !(confirmedLimitWithoutEditor || sameComposerProbe(first, second)) ||
      (!confirmedLimitWithoutEditor && first.status === "unknown") ||
      first.url !== guest.nav.url ||
      guestFor(environmentId, entry.id).webview !== guest.webview ||
      isChatGPTGuestHibernated(guest.runtimeId)
    )
      return unknown("guest_or_draft_changed");
    const writer = window.desktopBridge?.savePrivateChatGPTDraftSnapshot;
    if (!writer) return unknown("private_desktop_backup_unavailable");
    // The ledger is snapshotted without reconciliation or deletion. Fail when
    // a send arrived during the two DOM observations.
    if (!ledgerUnchanged()) return unknown("uncertain_send_changed");
    try {
      const saved = await writer({
        sessionId: entry.id,
        url: first.url,
        draft: confirmedLimitWithoutEditor ? "" : first.status === "unknown" ? "" : first.text,
        uncertainSend: pending
          ? {
              text: pending.text,
              original: pending.original,
              url: pending.url,
              before: { ...pending.before },
              policyEnrichment: { ...pending.policyEnrichment },
            }
          : null,
      });
      if (
        !ledgerUnchanged() ||
        guestFor(environmentId, entry.id).webview !== guest.webview ||
        isChatGPTGuestHibernated(guest.runtimeId)
      )
        return unknown("guest_or_send_changed_during_backup");
      return {
        status: first.status === "nonempty" ? "backed_up_nonempty" : "backed_up_empty",
        ...saved,
        // No raw draft, send text or transcript can escape the desktop-only writer.
      };
    } catch {
      return unknown("private_backup_failed");
    }
  }
  if (!entry.hidden && action !== "restore") {
    if (input.neverWake) {
      if (!isLoadedChatGPTBrowserGuest(environmentId, entry))
        throw new Error("ChatGPT guest is hibernated, unmounted or loading; not waking it.");
    } else {
      await ensureGuestAwake(environmentId, entry.id);
    }
  }
  if (action === "restore") {
    if (
      !entry.archive ||
      !CANONICAL_CHATGPT_CONVERSATION_ID.test(
        chatGPTConversationIdFromUrl(entry.archive.conversationUrl) ?? "",
      )
    )
      throw new Error("Session has no valid, restorable manager archive.");
    if (!entry.hidden && !entry.archive.restoredAt)
      throw new Error("Archive state is inconsistent; refusing restore.");
    return {
      sessionId: entry.id,
      archive: entry.archive,
      alreadyRestored: !entry.hidden,
    };
  }
  if (action === "archive") {
    if (entry.hidden) {
      if (
        entry.archive &&
        !entry.archive.restoredAt &&
        CANONICAL_CHATGPT_CONVERSATION_ID.test(
          chatGPTConversationIdFromUrl(entry.archive.conversationUrl) ?? "",
        )
      ) {
        const ref = chatGPTBrowserThreadRef(environmentId, entry.id);
        const state = readThreadPreviewState(ref);
        const guest = guestFor(environmentId, entry.id);
        // After a previous successful close there is nothing to inspect or
        // release. If an interrupted close left an unmounted live preview, its
        // generation state is unknowable: restoring first is the safe recovery.
        if (Object.keys(state.sessions).length > 0 && !guest.webview)
          throw new Error(
            "Archived preview still exists but cannot be inspected; restore it before retrying archive.",
          );
        if (guest.webview) {
          if (guest.loading) throw new Error("Archived guest is loading; refusing close.");
          const page = await readGuest(environmentId, entry.id, "end", 1, false);
          if (
            !page ||
            page.activity !== "idle" ||
            page.lastRole !== "assistant" ||
            page.stuck ||
            page.connectionInterrupted ||
            chatGPTConversationIdFromUrl(page.url) !==
              chatGPTConversationIdFromUrl(entry.archive.conversationUrl)
          )
            throw new Error("Archived guest is active or uncertain; refusing close.");
        }
        return { sessionId: entry.id, archive: entry.archive, alreadyArchived: true };
      }
      throw new Error("Hidden session has no active manager archive and cannot be inspected.");
    }
    const decision = input.managerDecision === true && !!input.reason?.trim();
    if (input.managerDecision === true && !decision)
      throw new Error("Explicit managerDecision requires a nonempty reason.");
    if (input.reason !== undefined && !input.managerDecision)
      throw new Error("A reason requires managerDecision=true.");
    if (input.reason && input.reason.length > 500)
      throw new Error("Manager decision reason must be at most 500 characters.");
    const check = async () => {
      const current = await inspectBrowserSession(environmentId, entry);
      assertArchivableSession(entry, current, decision);
      const descendants = descendantSessions(sessions, entry.id);
      for (let i = 0; i < descendants.length; i += 4) {
        await Promise.all(
          descendants.slice(i, i + 4).map(async (child) => {
            if (child.hidden && child.archive && !child.archive.restoredAt) return;
            if (child.hidden) throw new Error(`Descendant ${child.id} has unknown hidden status.`);
            const observed = await inspectBrowserSession(environmentId, child);
            // A manager decision for the parent is not a declaration about its workers.
            assertArchivableSession(child, observed, false);
          }),
        );
      }
      return current;
    };
    await check();
    // Recheck directly before the renderer commits the archive. A DOM-idle hint
    // is not completion and no claimed managerSessionId conveys authority.
    const current = await check();
    return {
      sessionId: entry.id,
      archive: {
        archivedAt: new Date().toISOString(),
        conversationUrl: current.observedGuestUrl!,
        basis: decision ? ("manager_decision" as const) : ("completion" as const),
        ...(decision ? { reason: input.reason!.trim() } : {}),
      },
      alreadyArchived: false,
    };
  }
  if (action === "change_state") {
    const state = input.state;
    if (state !== "hidden" && state !== "unhidden" && state !== "closed")
      throw new Error("change_state requires state=hidden, unhidden or closed.");
    if (state === "unhidden") {
      const archivedUrl =
        entry.archive && !entry.archive.restoredAt ? entry.archive.conversationUrl : null;
      if (
        archivedUrl &&
        !CANONICAL_CHATGPT_CONVERSATION_ID.test(chatGPTConversationIdFromUrl(archivedUrl) ?? "")
      )
        throw new Error("Archived session has no canonical conversation URL; cannot unhide.");
      return {
        action,
        state,
        sessionId: entry.id,
        alreadyInState: !entry.hidden,
        ...(archivedUrl ? { conversationUrl: archivedUrl } : {}),
      };
    }
    if (state === "hidden" && entry.hidden)
      return { action, state, sessionId: entry.id, alreadyInState: true };
    if (state === "closed" && entry.hidden) {
      const preview = readThreadPreviewState(chatGPTBrowserThreadRef(environmentId, entry.id));
      if (guestFor(environmentId, entry.id).webview || Object.keys(preview.sessions).length)
        throw new Error("Hidden session still has a preview; unhide and close safely first.");
      return { action, state, sessionId: entry.id, alreadyInState: false };
    }
    const before = await inspectBrowserSession(environmentId, entry);
    // Hiding an active guest is disruptive; closing an explicitly addressed
    // local container is not. ChatGPT continues generating on its servers.
    if (state === "hidden" && (before.status === "working" || before.uiColor === "working"))
      throw new Error("Refusing to hide while ChatGPT is generating.");
    if (state === "hidden") {
      const latest = await inspectBrowserSession(environmentId, entry);
      if (
        latest.status === "working" ||
        latest.uiColor === "working" ||
        latest.observedGuestUrl !== before.observedGuestUrl
      )
        throw new Error("Session became active or navigated during hide inspection.");
    }
    if (state === "closed") {
      // Only the exact session ID can be closed. Active generation and a
      // pending assistant reply are remote work, not unsent local content.
      const closable = (status: string) =>
        ["new", "working", "pending_or_stalled", "done_or_idle", "waiting_for_input"].includes(
          status,
        );
      if (!closable(before.status) || !before.observedGuestUrl)
        throw new Error("Cannot permanently close an unreadable or interrupted session.");
      if (hasUncertainChatGPTSend(environmentId, entry.id))
        throw new Error("Cannot permanently close a session with an UNKNOWN send.");
      const { runtimeId, webview } = guestFor(environmentId, entry.id);
      if (!runtimeId || !webview)
        throw new Error("Cannot inspect the exact session guest before permanent close.");
      // Check again immediately before returning the closure authorization:
      // closing must never destroy a composer draft or UNKNOWN send.
      for (let check = 0; check < 2; check++) {
        const draft = await chatGPTWebviewAutomation.evaluate(runtimeId, {
          expression: `(() => {const el=document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)});
            return el instanceof HTMLTextAreaElement ? el.value :
              el instanceof HTMLElement ? (el.innerText||el.textContent||"") : null;})()`,
        });
        if (typeof draft !== "string" || draft.trim())
          throw new Error("Cannot permanently close: composer draft is nonempty or unreadable.");
        const latest = await inspectBrowserSession(environmentId, entry);
        const exactGuest = guestFor(environmentId, entry.id);
        if (
          latest.observedGuestUrl !== before.observedGuestUrl ||
          !closable(latest.status) ||
          exactGuest.runtimeId !== runtimeId ||
          exactGuest.webview !== webview ||
          hasUncertainChatGPTSend(environmentId, entry.id)
        )
          throw new Error("Session guest, conversation or send changed during close inspection.");
      }
    }
    return { action, state, sessionId: entry.id, alreadyInState: false };
  }
  if (entry.hidden) throw new Error("Session is hidden; restore it before controlling it.");
  if (action === "reconcile_send") {
    if (!input.expectedConversationId || !input.message?.trim())
      throw new Error("Reconciliation requires the exact conversation and original sent message.");
    const session = await inspectBrowserSession(environmentId, entry, "end", 20, true, 24_000);
    requireExpectedChatGPTConversation(input.expectedConversationId, session.observedGuestUrl);
    const receipt = readDurableUnknownChatGPTSend(environmentId, entry.id);
    if (!receipt)
      return {
        sessionId: entry.id,
        reconciled: true,
        alreadyResolved: true,
        sendAttempted: false,
        conversationGuardValidated: true,
        verifiedConversationId: input.expectedConversationId,
      };
    if (receipt.conversationUrl !== session.observedGuestUrl)
      throw new Error("UNKNOWN receipt belongs to a different conversation; preserve it.");
    const pending = pendingChatGPTSend(environmentId, entry.id);
    const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
    // Legacy markers have no original payload. Explicit reconciliation accepts
    // an observed history checkpoint, without claiming the lost send delivered.
    const expected = pending?.text ?? input.message;
    if (
      pending &&
      normalize(input.message) !== normalize(pending.original) &&
      normalize(input.message) !== normalize(pending.text)
    )
      throw new Error("Message does not match the reserved UNKNOWN send.");
    const { runtimeId } = guestFor(environmentId, entry.id);
    if (!runtimeId) throw new Error("ChatGPT guest is not attached.");
    const observed = await chatGPTWebviewAutomation.evaluate(runtimeId, {
      expression: `(() => { if (location.href !== ${JSON.stringify(receipt.conversationUrl)}) return false;
        const normalize = text => text.replace(/\\s+/gu, ' ').trim();
        return Array.from(document.querySelectorAll('[data-message-author-role="user"],[data-content-search-unit-key$=":user"]'))
          .some(el => normalize(el.innerText || el.textContent || '') === ${JSON.stringify(normalize(expected))}); })()`,
    });
    if (observed !== true)
      throw new Error(
        "Original user message is not observable; no send or receipt change occurred.",
      );
    releaseDurableUnknownChatGPTSend(environmentId, entry.id);
    uncertainChatGPTSends.delete(sendReceiptKey(environmentId, entry.id));
    return {
      sessionId: entry.id,
      reconciled: true,
      delivery: pending ? "user_turn_observed" : "legacy_unknown_resolved_at_observed_checkpoint",
      conversationGuardValidated: true,
      verifiedConversationId: input.expectedConversationId,
      legacyReceipt: !pending,
      sendAttempted: false,
      observedAt: new Date().toISOString(),
    };
  }
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
    const receiptKey = sendReceiptKey(environmentId, entry.id);
    const pending = pendingChatGPTSend(environmentId, entry.id);
    const persistedUnknown = hasDurableUnknownChatGPTSend(environmentId, entry.id);
    let sendReceipt:
      | {
          delivery: "unknown" | "user_turn_observed";
          sendAttempted: true;
          conversationUrl?: string;
          reservedAt?: number;
        }
      | undefined;
    if (pending && pending.url === session.observedGuestUrl) {
      let delivered = false;
      const { runtimeId } = guestFor(environmentId, entry.id);
      if (runtimeId) {
        try {
          delivered = await reconcileChatGPTSend(environmentId, entry.id, runtimeId, pending);
        } catch {
          /* read still reports the actual transcript */
        }
      }
      if (delivered) {
        releaseDurableUnknownChatGPTSend(environmentId, entry.id);
        uncertainChatGPTSends.delete(receiptKey);
      }
      sendReceipt = { delivery: delivered ? "user_turn_observed" : "unknown", sendAttempted: true };
    } else if (pending) {
      // A new URL does not prove that the old user message was delivered.
      // Retain the unrelated pending receipt until explicit reconciliation.
      sendReceipt = { delivery: "unknown", sendAttempted: true };
    } else if (persistedUnknown) {
      const receipt = readDurableUnknownChatGPTSend(environmentId, entry.id);
      sendReceipt = {
        delivery: "unknown",
        sendAttempted: true,
        ...(receipt
          ? { conversationUrl: receipt.conversationUrl, reservedAt: receipt.reservedAt }
          : {}),
      };
    }
    if (input.expectedConversationId !== undefined) {
      const verifiedConversationId = requireExpectedChatGPTConversation(
        input.expectedConversationId,
        session.observedGuestUrl,
      );
      return {
        session,
        selection: { from, count },
        recoveryLog: readChatGPTRecoveryEvents(environmentId, entry.id),
        recoveryState: readChatGPTRecoveryState(environmentId, entry.id),
        ...(sendReceipt ? { sendReceipt } : {}),
        conversationGuardValidated: true,
        verifiedConversationId,
      };
    }
    return {
      session,
      selection: { from, count },
      recoveryLog: readChatGPTRecoveryEvents(environmentId, entry.id),
      recoveryState: readChatGPTRecoveryState(environmentId, entry.id),
      ...(sendReceipt ? { sendReceipt } : {}),
    };
  }
  if (action === "complete") {
    const observed = await inspectBrowserSession(environmentId, entry);
    if (
      !observed.conversationId ||
      !["working", "done_or_idle", "waiting_for_input"].includes(observed.status)
    ) {
      throw new Error("Cannot declare completion without a readable ChatGPT conversation.");
    }
    // This signal means the caller says the task is complete; it is not an
    // LLM-derived inference and the local socket cannot authenticate the caller.
    return {
      sessionId: entry.id,
      completion: {
        declaredAt: new Date().toISOString(),
        observedTurns: observed.totalTurns,
        observedUrl: observed.url,
      },
      acknowledged: true,
      basis: "caller_declared" as const,
    };
  }
  if (action === "reload") {
    // Manual force reload and the background scanner must never mutate an
    // environment concurrently. Fail before any guest inspection or action.
    const mutationLease = tryAcquireChatGPTRecoveryMutation(
      environmentId, entry.id, "manual", "reload",
    );
    if (!mutationLease)
      throw new Error("Another browser recovery is in progress; retry after it settles.");
    try {
    recordChatGPTRecoveryEvent(
      environmentId,
      entry.id,
      "manual-reload-requested",
      input.force ? "forced" : "guarded",
    );
    const before = await inspectBrowserSession(environmentId, entry);
    if (before.recoveryProblem === "browser-unresponsive") {
      if (!input.force)
        throw new Error(
          "Browser instance is unresponsive; pass force=true to replace it. In-memory drafts may be lost.",
        );
      if (input.shouldContinue && !input.shouldContinue())
        throw new Error("The target session is no longer selected; cancelling reset.");
      const guest = guestFor(environmentId, entry.id);
      if (!guest.runtimeId || !guest.webview || !chatGPTBrowserFailure(guest.webview))
        throw new Error("The failed browser instance changed before reset.");
      recordRecoveryAttempt(
        environmentId,
        entry.id,
        Date.now(),
        sessions.map((s) => s.id),
      );
      recordChatGPTRecoveryEvent(environmentId, entry.id, "browser-reset-requested", "manual");
      try {
        const reset = await resetHostedBrowserGuest(guest.runtimeId);
        recordChatGPTRecoveryEvent(
          environmentId,
          entry.id,
          "browser-reset-attached",
          `${reset.previousWebContentsId}->${reset.webContentsId}`,
        );
        return {
          sessionId: entry.id,
          browserInstanceReset: true,
          ...reset,
          pageRecoveryVerified: false,
        };
      } catch (error) {
        recordChatGPTRecoveryEvent(environmentId, entry.id, "browser-reset-unconfirmed");
        throw error;
      }
    }
    // An explicit force=true is the deliberate interruption decision for a
    // working session. Automatic/ordinary reloads still cannot interrupt it.
    const workingBefore = before.status === "working" || before.uiColor === "working";
    if (workingBefore && !input.force)
      throw new Error("Session is working. Pass force=true to deliberately interrupt generation and reload; unfinished assistant output may be lost.");
    if (hasUncertainChatGPTSend(environmentId, entry.id))
      throw new Error("Session has an UNKNOWN send; reconcile delivery before reloading.");
    // Orange means the same interrupted/delivery-timeout states rendered by the
    // sidebar. Explicit force is required only there, not for ordinary reloads.
    const orange = reloadRequiresForce(before.uiColor);
    if (orange && !input.force) {
      throw new Error("Session is orange (interrupted delivery); pass force=true to reload.");
    }
    // A transient redirect from /c/<id> to the empty ChatGPT homepage is
    // identity loss, not an error that a refresh of / can repair. Reattach only
    // with a canonical saved identity and two inspections of the same empty guest.
    if (isChatGPTHomeUrl(before.observedGuestUrl ?? "")) {
      let saved: unknown = null;
      try {
        saved = JSON.parse(
          localStorage.getItem(chatGPTBrowserLastUrlKey(environmentId, entry.id)) ?? "null",
        );
      } catch {
        throw new Error("Saved ChatGPT URL is unreadable; refusing recovery.");
      }
      const expected = typeof saved === "string" ? chatGPTConversationIdFromUrl(saved) : null;
      if (!expected || !CANONICAL_CHATGPT_CONVERSATION_ID.test(expected)) {
        throw new Error("No canonical saved ChatGPT conversation URL; refusing recovery.");
      }
      const original = guestFor(environmentId, entry.id);
      if (!original.runtimeId || !original.webview || !previewBridge) {
        throw new Error("The exact ChatGPT guest is not attached.");
      }
      const safeGuest = async () => {
        const latest = guestFor(environmentId, entry.id);
        if (latest.runtimeId !== original.runtimeId || latest.webview !== original.webview)
          return false;
        const inspection = await readGuest(environmentId, entry.id, "end", 1, false);
        if (
          !inspection ||
          !isChatGPTHomeUrl(inspection.url) ||
          inspection.activity !== "idle" ||
          inspection.totalTurns !== 0 ||
          inspection.connectionInterrupted
        )
          return false;
        return (
          (await chatGPTWebviewAutomation.evaluate(original.runtimeId!, {
            expression: CHATGPT_SAFE_EMPTY_HOME_EXPRESSION,
          })) === true
        );
      };
      if (!(await safeGuest()) || !(await safeGuest()))
        throw new Error("Guest changed, is active, or contains a draft; refusing recovery.");
      if (input.shouldContinue && !input.shouldContinue())
        throw new Error("The target session is no longer selected; cancelling recovery.");
      // Share the recovery scheduler's global/per-tab history so a manual
      // navigation cannot be followed by an immediate automatic retry.
      recordRecoveryAttempt(
        environmentId,
        entry.id,
        Date.now(),
        sessions.map((s) => s.id),
      );
      // Do not overwrite last-url: it is already the durable conversation identity.
      await previewBridge.navigate(original.runtimeId, saved as string);
      recordChatGPTRecoveryEvent(environmentId, entry.id, "manual-navigate-issued", "saved-url");
      return {
        sessionId: entry.id,
        recoveredUrl: saved,
        requestedNavigation: true,
        previousStatus: before.status,
      };
    }
    // A tab redirected to another conversation is not permission to refresh
    // that unrelated page, even when the rendered activity looks idle.
    const observedConversation = chatGPTConversationIdFromUrl(before.observedGuestUrl);
    if (!observedConversation)
      throw new Error("Session is not showing a canonical ChatGPT conversation; refusing refresh.");
    let savedConversation: string | null = null;
    try {
      const savedUrl = JSON.parse(
        localStorage.getItem(chatGPTBrowserLastUrlKey(environmentId, entry.id)) ?? "null",
      );
      savedConversation =
        typeof savedUrl === "string" ? chatGPTConversationIdFromUrl(savedUrl) : null;
    } catch {
      throw new Error("Saved ChatGPT URL is unreadable; refusing refresh.");
    }
    if (savedConversation && savedConversation !== observedConversation)
      throw new Error("Session navigated to an unrelated conversation; refusing refresh.");
    // The page can start generating or change conversation while a pipe request
    // waits. Recheck on every refresh, including ordinary healthy idle pages.
    const latest = await inspectBrowserSession(environmentId, entry);
    const workingAtCommit = latest.status === "working" || latest.uiColor === "working";
    if (workingAtCommit && !input.force)
      throw new Error("Session began working before refresh. Pass force=true to deliberately interrupt generation.");
    if (
      latest.observedGuestUrl !== before.observedGuestUrl ||
      (!input.force && reloadRequiresForce(latest.uiColor))
    )
      throw new Error("Session URL or orange state changed before refresh; not reloading.");
    const guest = guestFor(environmentId, entry.id);
    const { runtimeId, webview } = guest;
    if (!runtimeId || !webview) throw new Error("ChatGPT guest is not attached.");
    // A forced refresh may interrupt generation, never typed drafts, attachments
    // or a pending/UNKNOWN send. Fail closed if the composer cannot be inspected.
    if (!(await hasVerifiedEmptyChatGPTComposer(webview, latest.observedGuestUrl!)))
      throw new Error("Composer draft is nonempty or uninspectable; refusing reload.");
    const noAttachments = await chatGPTWebviewAutomation.evaluate(runtimeId, {
      expression: `(() => { const composer = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"]');
        const form = composer?.closest('form');
        if (!form) return false;
        if (form.querySelector('img,video,audio,[data-testid*="attachment"],[data-testid*="upload-preview"],[data-state="recording"],[data-state="uploading"],[aria-label^="Remove file"],[aria-label^="Remove attachment"]')) return false;
        return !Array.from(form.querySelectorAll('input[type="file"]')).some(input => input.files?.length); })()`,
    });
    if (noAttachments !== true || hasUncertainChatGPTSend(environmentId, entry.id) ||
        guestFor(environmentId, entry.id).webview !== webview ||
        guestFor(environmentId, entry.id).runtimeId !== runtimeId)
      throw new Error("Session changed, has attachments or an UNKNOWN send; refusing reload.");
    recordRecoveryAttempt(
      environmentId,
      entry.id,
      Date.now(),
      sessions.map((s) => s.id),
    );
    // The final draft/attachment/identity check and reload share ONE guest JS
    // turn; a user typing after the earlier asynchronous checks cannot lose a
    // newly entered draft between a separate preflight and host refresh IPC.
    const issued = await webview.executeJavaScript(`(() => {
      if (location.href !== ${JSON.stringify(latest.observedGuestUrl)}) return false;
      const draft = (${inspectChatGPTComposer.toString()})(document, location.href);
      if (draft.status !== 'empty') return false;
      const composer = document.querySelector('#prompt-textarea,[data-testid="prompt-textarea"],[data-testid="composer-input"]');
      const form = composer?.closest('form');
      if (!form || form.querySelector('img,video,audio,[data-testid*="attachment"],[data-testid*="upload-preview"],[data-state="recording"],[data-state="uploading"],[aria-label^="Remove file"],[aria-label^="Remove attachment"]') ||
          Array.from(form.querySelectorAll('input[type="file"]')).some(input => input.files?.length)) return false;
      const page = (${inspectChatGPTPage.toString()})({from:'end',count:1,includeMessages:false});
      if (!${input.force === true} && page.activity !== 'idle') return false;
      location.reload();
      return true;
    })()`);
    if (issued !== true) throw new Error("Guest changed or contains a draft/attachment; refusing reload.");
    recordChatGPTSessionRefreshedAt(environmentId, entry.id);
    const forcedWorkingReload = input.force === true && (workingBefore || workingAtCommit);
    recordChatGPTRecoveryEvent(environmentId, entry.id, "manual-refresh-issued", forcedWorkingReload ? "force-interrupt" : before.status);
    return {
      sessionId: entry.id, reloaded: true, previousStatus: before.status,
      ...(forcedWorkingReload ? {
        forcedWorkingReload: true,
        warning: "Explicit forced reload interrupted or may have interrupted an unfinished assistant response.",
      } : {}),
    };
    } finally {
      // Even a rejected/ambiguous manual action must not leave a stale lease;
      // awaited browser actions retain it until they actually settle.
      mutationLease.release();
    }
  }
  if (action === "send") {
    const prepared = prepareChatGPTSessionMessage(
      sessions,
      entry.id,
      input.message ?? "",
      input.senderSessionId,
    );
    const before = await inspectBrowserSession(environmentId, entry, "end", 1, true);
    if (input.expectedConversationId !== undefined) {
      requireExpectedChatGPTConversation(input.expectedConversationId, before.observedGuestUrl);
    }
    const receiptKey = sendReceiptKey(environmentId, entry.id);
    let unresolved = pendingChatGPTSend(environmentId, entry.id);
    // Resolve any positively observed earlier delivery before considering a new message.
    if (unresolved && unresolved.url === before.observedGuestUrl) {
      const { runtimeId } = guestFor(environmentId, entry.id);
      if (
        runtimeId &&
        (await reconcileChatGPTSend(environmentId, entry.id, runtimeId, unresolved))
      ) {
        const sameMessage = unresolved.original === prepared.text;
        releaseDurableUnknownChatGPTSend(environmentId, entry.id);
        uncertainChatGPTSends.delete(receiptKey);
        unresolved = undefined;
        if (sameMessage)
          return {
            sessionId: entry.id,
            recipientSessionId: entry.id,
            senderSessionId: prepared.sender?.id ?? null,
            messageSent: true,
            delivery: "user_turn_observed",
            reconciled: true,
            ...(input.expectedConversationId
              ? {
                  conversationGuardValidated: true,
                  verifiedConversationId: input.expectedConversationId,
                }
              : {}),
            observedAt: new Date().toISOString(),
          };
      }
    }
    const legacyUnknown = !unresolved
      ? readDurableUnknownChatGPTSend(environmentId, entry.id) : null;
    // Legacy v1 receipts preserved only a URL, not the original message. They
    // cannot be positively reconciled. A *new* guarded send may proceed after
    // proving the same idle conversation and a truly empty composer below;
    // archive the original unresolved evidence instead of deleting it.
    if (legacyUnknown && (legacyUnknown.attempt || !input.expectedConversationId ||
      legacyUnknown.conversationUrl !== before.observedGuestUrl)) {
      throw new Error("Unresolved UNKNOWN send needs its original conversation and guarded reconciliation.");
    }
    if (unresolved && unresolved.url !== before.observedGuestUrl)
      throw new Error(
        "UNKNOWN send belongs to a previous conversation; preserve and reconcile before sending.",
      );
    if (unresolved && unresolved.original === prepared.text) {
      const attached = guestFor(environmentId, entry.id);
      if (attached.runtimeId) {
        try {
          if (await reconcileChatGPTSend(environmentId, entry.id, attached.runtimeId, unresolved)) {
            releaseDurableUnknownChatGPTSend(environmentId, entry.id);
            uncertainChatGPTSends.delete(receiptKey);
            return {
              sessionId: entry.id,
              recipientSessionId: entry.id,
              senderSessionId: prepared.sender?.id ?? null,
              messageSent: true,
              delivery: "user_turn_observed" as const,
              reconciled: true,
              ...(input.expectedConversationId
                ? {
                    conversationGuardValidated: true as const,
                    verifiedConversationId: input.expectedConversationId,
                  }
                : {}),
              observedAt: new Date().toISOString(),
            };
          }
        } catch {
          /* uncertain remains uncertain */
        }
      }
      return {
        sessionId: entry.id,
        recipientSessionId: entry.id,
        senderSessionId: prepared.sender?.id ?? null,
        messageSent: false,
        delivery: "unknown" as const,
        sendAttempted: true,
        ...(input.expectedConversationId
          ? {
              conversationGuardValidated: true as const,
              verifiedConversationId: input.expectedConversationId,
            }
          : {}),
        reason:
          "A matching send was previously invoked but its user turn has not been proven. No duplicate click was issued; read the session and do not blindly retry.",
      };
    }
    // Generic keep-awake may be reattempted with a NEW UUID after an UNKNOWN,
    // but no other unknown may be cleared/displaced by a different send.
    const duplicateSafeReplacement =
      !!unresolved &&
      unresolved.url === before.observedGuestUrl &&
      canReplaceGenericUnknown(unresolved, prepared.text);
    if (unresolved && !duplicateSafeReplacement)
      throw new Error(
        "Unrelated or unverifiable UNKNOWN send remains; manual reconciliation required.",
      );
    // In particular pending_or_stalled is NOT a confirmed idle recipient:
    // a prior human turn may still be awaiting an assistant response.
    if (!["done_or_idle", "waiting_for_input"].includes(before.status) ||
        before.activity !== "idle")
      throw new Error("Conversation is not confirmed idle before typing; no message sent.");
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
    if (legacyUnknown && typeof draft !== "string")
      throw new Error("Cannot prove an empty composer; legacy UNKNOWN remains held.");
    // Optional C05 applies only to an already authorized guarded send to an existing
    // guest. Never scans idle browsers or wakes guests solely to fetch policy.
    let policyEnrichment: {
      schema: "t3-c05-browser-optional/v1";
      status: "deferred" | "not_eligible" | "prepared" | "observed_user_turn";
      reason?: string;
      qitemIds?: string[];
    } = {
      schema: "t3-c05-browser-optional/v1",
      status: "not_eligible",
      reason: "exact_conversation_guard_not_supplied",
    };
    let message = prepared.text;
    const policyReader =
      typeof window !== "undefined"
        ? window.desktopBridge?.readOpenRigPolicyForBrowserSend
        : undefined;
    const guardedConversation = input.expectedConversationId;
    if (
      guardedConversation &&
      policyReader &&
      chatGPTConversationIdFromUrl(before.observedGuestUrl ?? "") === guardedConversation
    ) {
      try {
        const intake = await Promise.race([
          policyReader({ browserSessionId: entry.id, conversationId: guardedConversation }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("policy_intake_timeout")), 7_000),
          ),
        ]);
        if (
          intake.status === "ready" &&
          intake.browserSessionId === entry.id &&
          intake.conversationId === guardedConversation &&
          intake.policies.length > 0
        ) {
          // The MAIN bridge independently proves one exact RigSpec manager's current
          // active primary. The renderer additionally rechecks guest identity below.
          const candidate = appendUnverifiedOpenRigPolicies(prepared.text, intake.policies);
          if (candidate.length <= 30_000) {
            message = candidate;
            policyEnrichment = {
              schema: "t3-c05-browser-optional/v1",
              status: "prepared",
              qitemIds: [...new Set(intake.policies.map((row) => row.qitemId))],
            };
          } else
            policyEnrichment = {
              schema: "t3-c05-browser-optional/v1",
              status: "deferred",
              reason: "policy_context_oversized",
            };
        } else if (intake.status === "ready") {
          policyEnrichment = {
            schema: "t3-c05-browser-optional/v1",
            status: "deferred",
            reason: intake.policies.length === 0 ? "no_pending_policy" : "policy_identity_mismatch",
          };
        } else
          policyEnrichment = {
            schema: "t3-c05-browser-optional/v1",
            status: "deferred",
            reason: intake.reason,
          };
      } catch (error) {
        policyEnrichment = {
          schema: "t3-c05-browser-optional/v1",
          status: "deferred",
          reason:
            error instanceof Error && error.message === "policy_intake_timeout"
              ? "policy_intake_timeout"
              : "policy_ipc_unavailable",
        };
      }
    } else if (guardedConversation) {
      policyEnrichment = {
        schema: "t3-c05-browser-optional/v1",
        status: "deferred",
        reason: policyReader ? "exact_guest_url_not_verified" : "policy_ipc_unavailable",
      };
    }
    // The policy read is optional: original send guards remain binding. Reinspect
    // the same guest after every awaited policy IPC before a single editor mutation.
    const refreshed = await inspectBrowserSession(environmentId, entry, "end", 1, true);
    if (guardedConversation) {
      requireExpectedChatGPTConversation(guardedConversation, refreshed.observedGuestUrl);
    }
    if (
      refreshed.observedGuestUrl !== before.observedGuestUrl ||
      !["done_or_idle", "waiting_for_input"].includes(refreshed.status) ||
      refreshed.activity !== "idle" ||
      guestFor(environmentId, entry.id).runtimeId !== runtimeId
    ) {
      throw new Error("Session URL, generation or guest changed before typing; refusing send.");
    }
    if ((uncertainChatGPTSends.get(receiptKey) ?? null) !== (unresolved ?? null))
      throw new Error("Unknown-send ledger changed before typing; aborting.");
    if (legacyUnknown && !archiveLegacyUnknownChatGPTSend(
      environmentId, entry.id, before.observedGuestUrl ?? ""))
      throw new Error("Legacy UNKNOWN evidence could not be archived; send remains blocked.");
    await chatGPTWebviewAutomation.waitFor(runtimeId, {
      selector: COMPOSER_SELECTOR,
      timeoutMs: 3000,
    });
    await chatGPTWebviewAutomation.type(runtimeId, {
      selector: COMPOSER_SELECTOR,
      text: message,
      clear: true,
      requireEmptyComposer: true,
      expectedConversationId: input.expectedConversationId,
    });
    // Record the attempt before the click: even an exception from the bridge
    // may follow a real side effect. A repeated call must reconcile, not click.
    const attempt: PendingChatGPTSend = {
      original: prepared.text,
      text: message,
      url: before.observedGuestUrl ?? "",
      before: { totalTurns: before.totalTurns, lastUserTurnKey: before.lastUserTurnKey },
      policyEnrichment,
    };
    reserveDurableUnknownChatGPTSend(
      environmentId,
      entry.id,
      attempt.url,
      duplicateSafeReplacement,
      attempt,
    );
    uncertainChatGPTSends.set(receiptKey, attempt);
    try {
      await chatGPTWebviewAutomation.press(runtimeId, {
        key: "Enter",
        expectedConversationId: input.expectedConversationId,
      });
    } catch {
      return {
        sessionId: entry.id,
        recipientSessionId: entry.id,
        senderSessionId: prepared.sender?.id ?? null,
        messageSent: false,
        delivery: "unknown" as const,
        sendAttempted: true,
        ...(input.expectedConversationId
          ? {
              conversationGuardValidated: true as const,
              verifiedConversationId: input.expectedConversationId,
            }
          : {}),
        reason:
          "Send was invoked but the guest bridge did not confirm the click. Outcome unknown; never retry blindly.",
      };
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        if (await reconcileChatGPTSend(environmentId, entry.id, runtimeId, attempt)) {
          releaseDurableUnknownChatGPTSend(environmentId, entry.id);
          uncertainChatGPTSends.delete(receiptKey);
          return {
            sessionId: entry.id,
            recipientSessionId: entry.id,
            senderSessionId: prepared.sender?.id ?? null,
            messageSent: true,
            delivery: "user_turn_observed" as const,
            policyEnrichment:
              policyEnrichment.status === "prepared"
                ? { ...policyEnrichment, status: "observed_user_turn" as const }
                : policyEnrichment,
            ...(input.expectedConversationId
              ? {
                  conversationGuardValidated: true as const,
                  verifiedConversationId: input.expectedConversationId,
                }
              : {}),
            observedAt: new Date().toISOString(),
          };
        }
      } catch {
        /* guest inspection can fail after the click; receipt remains unknown */
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return {
      sessionId: entry.id,
      recipientSessionId: entry.id,
      senderSessionId: prepared.sender?.id ?? null,
      messageSent: false,
      delivery: "unknown" as const,
      sendAttempted: true,
      ...(input.expectedConversationId
        ? {
            conversationGuardValidated: true as const,
            verifiedConversationId: input.expectedConversationId,
          }
        : {}),
      policyEnrichment,
      reason:
        "Send was invoked but no new matching user turn could be proven. Inspect the session; do not retry blindly.",
    };
  }
  throw new Error("Unsupported action.");
}
