import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback } from "react";
import { useStore } from "zustand";
import {
  filterClosedChatGPTSessions,
  getChatGPTSessionPersistedStore,
} from "./chatGPTSessionPersistedStore";

import { previewRuntimeTabId } from "./browser/previewRuntimeTabId";
import { clearChatGPTGuestUserOpened } from "./browser/chatGPTGuestHibernation";
import { isPersistentChatGPTSessionOptedIn } from "./browser/persistentChatGPTSessionMode";
import {
  nextChatGPTBootstrapGeneration,
  registerChatGPTBootstrapMarker,
  type ChatGPTBootstrapObservation,
} from "./chatGPTBootstrapIdentity";
import {
  CANONICAL_CHATGPT_CONVERSATION_ID,
  chatGPTConversationIdFromUrl,
} from "./chatGPTConversationIdentity";
import { chatGPTPrewarmKey, isChatGPTHomeUrl, takeChatGPTSpare } from "./chatGPTBrowserPrewarm";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { readVerifiedT3CaffyOverview, T3_CAFFY_UPDATED_EVENT } from "./hooks/useT3CaffyOverview";
import { randomUUID } from "./lib/utils";
import { recordChatGPTWakeAudit } from "./chatGPTWakeAudit";
import {
  PRIMARY_CHATGPT_PROFILE_ID,
  readNewChatGPTProfileId,
  resetNewChatGPTProfileId,
} from "./chatGPTAccountProfiles";
import {
  finalizeChatGPTRolloverHierarchy,
  type ChatGPTRolloverPlan,
} from "./chatGPTRolloverFinalize";
import { readThreadPreviewState } from "./previewStateStore";

export const ChatGPTSessionBinding = Schema.Struct({
  seatId: Schema.NullOr(Schema.String),
  role: Schema.Literals(["manager", "worker", "personal"]),
  parentSessionId: Schema.NullOr(Schema.String),
  taskRef: Schema.NullOr(Schema.Struct({ board: Schema.String, id: Schema.String })),
  boundAt: Schema.String,
  boundBy: Schema.Literals(["omcp_spawn", "openrig", "user"]),
});
export type ChatGPTSessionBinding = typeof ChatGPTSessionBinding.Type;

export const BrowserSession = Schema.Struct({
  id: Schema.String,
  /** Immutable browser-login identity. Absent on old sessions means the first account. */
  profileId: Schema.optional(Schema.String),
  title: Schema.String,
  /** User-initiated rename takes precedence over automatic Bootstrap naming. */
  titleSource: Schema.optional(Schema.Literals(["user", "bootstrap"])),
  // Absent on legacy sessions, which may still register opportunistically.
  // See chatGPTBootstrapIdentity.ts for the internal vs public ID model.
  bootstrapIdentity: Schema.optional(
    Schema.Struct({
      state: Schema.Literals(["awaiting_marker", "registered", "mismatch"]),
      publicId: Schema.optional(Schema.String),
      conversationId: Schema.optional(Schema.String),
      reportedId: Schema.optional(Schema.String),
      titlePendingUntil: Schema.optional(Schema.Number),
    }),
  ),
  // Present only for sessions created after timestamp tracking was introduced.
  createdAt: Schema.optional(Schema.Number),
  // Immutable creation evidence. Older entries without it remain unknown unless
  // they carry an explicit backend spawn reservation; titles/lineage are not proof.
  creationOrigin: Schema.optional(Schema.Literals(["manual", "backend"])),
  // A backend-created worker becomes a personal chat after an actual human send
  // or a user-assigned highlight. Creation provenance remains unchanged.
  humanControlled: Schema.optional(Schema.Boolean),
  // Explicit reversible user designation; timestamp starts worker cleanup grace.
  markedAsWorkerAt: Schema.optional(Schema.Number),
  // An exact backend spawn reservation. Manual sessions and warm spares never carry it.
  spawnRequestId: Schema.optional(Schema.String),
  // Only new home-page sessions need their initial GPT-6 High selection.
  initialHighEffortPending: Schema.optional(Schema.Boolean),
  // Only explicit UI-created fresh chats carry this; legacy and backend guests do not.
  manualEmptyCandidateCreatedAt: Schema.optional(Schema.Number),
  manualEmptyCandidateDisqualified: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  hiddenAt: Schema.optional(Schema.Number),
  archive: Schema.optional(
    Schema.Struct({
      archivedAt: Schema.String,
      conversationUrl: Schema.String,
      basis: Schema.Literals(["completion", "manager_decision"]),
      reason: Schema.optional(Schema.String),
      restoredAt: Schema.optional(Schema.String),
    }),
  ),
  snoozedUntil: Schema.optional(Schema.Number),
  snoozedAt: Schema.optional(Schema.Number),
  verificationPending: Schema.optional(Schema.Boolean),
  /** When the current verification request entered the FIFO review queue. */
  verificationMarkedAt: Schema.optional(Schema.Number),
  quickSnoozeStep: Schema.optional(Schema.Number),
  // Automatically spawned workers close after two hours without work.
  autoClose: Schema.optional(Schema.Boolean),
  // Sticky exemptions: unsnooze or clearing a colored border never reenables auto-close.
  autoCloseExempt: Schema.optional(Schema.Boolean),
  lastDirectInteractionAt: Schema.optional(Schema.Number),
  // null explicitly detaches a child; undefined means no lineage was ever recorded.
  parentSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  binding: Schema.optional(ChatGPTSessionBinding),
  project: Schema.optional(Schema.String),
  // User-chosen sidebar border color name; unknown names render no border.
  borderColor: Schema.optional(Schema.String),
  /** ChatGPT confirmed this exact conversation reached its permanent length limit. */
  conversationFullId: Schema.optional(Schema.String),
  // Persisted across T3 restarts: armed needs a new working observation before becoming ready.
  returnMarker: Schema.optional(Schema.Literals(["armed", "working", "ready"])),
  completion: Schema.optional(
    Schema.Struct({
      declaredAt: Schema.String,
      observedTurns: Schema.Number,
      observedUrl: Schema.NullOr(Schema.String),
    }),
  ),
});
export type BrowserSession = typeof BrowserSession.Type;

/** Only a post-arming observed working -> idle cycle may turn a Return marker yellow.
 * This state lives on the persisted session, not in renderer-local activity history,
 * so reopening T3 cannot falsely complete a marker armed while idle. */
export function advanceChatGPTReturnMarker(
  marker: NonNullable<BrowserSession["returnMarker"]>,
  age: "working" | "idle" | "recent" | "inactive" | "unknown",
): NonNullable<BrowserSession["returnMarker"]> {
  if (age === "working" && (marker === "armed" || marker === "ready")) return "working";
  if (marker === "working" && age === "idle") return "ready";
  return marker;
}

/** A newly working session has resumed; verification and its automatic snooze are over. */
export function clearChatGPTVerificationOnWorking(session: BrowserSession): BrowserSession {
  return session.verificationPending
    ? {
        ...session,
        verificationPending: undefined,
        verificationMarkedAt: undefined,
        snoozedUntil: undefined,
        snoozedAt: undefined,
        quickSnoozeStep: undefined,
      }
    : session;
}

/** Persist the active-session transition to both session indexes. */
export function clearChatGPTSessionVerificationOnWorking(
  environmentId: string,
  sessionId: string,
): void {
  const store = getChatGPTSessionPersistedStore(environmentId);
  const current = store.getState().sessions;
  if (!current.some((session) => session.id === sessionId && session.verificationPending)) return;
  const next = current.map((session) =>
    session.id === sessionId ? clearChatGPTVerificationOnWorking(session) : session,
  );
  setLocalStorageItem(
    chatGPTBrowserSessionsKey(environmentId as EnvironmentId),
    next,
    BrowserSessions,
  );
  store.setState({ sessions: next });
}

/** Shared by the Ctrl+D shortcut, OMCPT requests and provider activity.
 * Persist to both session stores so another renderer sees the same marker. */
export function updateChatGPTReturnMarker(
  environmentId: string,
  id: string,
  update: (marker: BrowserSession["returnMarker"]) => BrowserSession["returnMarker"],
): BrowserSession["returnMarker"] {
  const store = getChatGPTSessionPersistedStore(environmentId);
  const current = store.getState().sessions;
  const entry = current.find((session) => session.id === id);
  if (!entry) return undefined;
  const marker = update(entry.returnMarker);
  if (marker === entry.returnMarker) return marker;
  const next = current.map((session) =>
    session.id === id ? { ...session, returnMarker: marker } : session,
  );
  setLocalStorageItem(
    chatGPTBrowserSessionsKey(environmentId as EnvironmentId),
    next,
    BrowserSessions,
  );
  store.setState({ sessions: next });
  return marker;
}

/** Persisted origin has priority except where a backend reservation proves otherwise. */
export function chatGPTSessionCreationOrigin(
  session: BrowserSession,
): "manual" | "backend" | "unknown" {
  if (session.spawnRequestId?.trim()) return "backend";
  return session.creationOrigin ?? "unknown";
}

/** Clear the new-session default only after ChatGPT confirms the model change. */
export function markInitialChatGPTHighEffortApplied(
  environmentId: EnvironmentId,
  sessionId: string,
): void {
  const store = getChatGPTSessionPersistedStore(environmentId);
  const current = store.getState().sessions;
  if (!current.some((entry) => entry.id === sessionId && entry.initialHighEffortPending)) return;
  // Omit the key rather than storing `undefined`: the registry sync schema only accepts JSON values.
  const next = current.map((entry): BrowserSession => {
    if (entry.id !== sessionId) return entry;
    const { initialHighEffortPending: _cleared, ...rest } = entry;
    return rest;
  });
  setLocalStorageItem(chatGPTBrowserSessionsKey(environmentId), next, BrowserSessions);
  store.setState({ sessions: next });
}

export const CHATGPT_CONVERSATION_FULL_MESSAGE =
  "This conversation has reached its maximum length. Sending is disabled; reboot this session to continue in a new chat.";

export function isChatGPTConversationFull(
  environmentId: string,
  sessionId: string,
  conversationId?: string | null,
): boolean {
  const session = getChatGPTSessionPersistedStore(environmentId)
    .getState()
    .sessions.find((entry) => entry.id === sessionId);
  return (
    !!session?.conversationFullId &&
    (conversationId == null || session.conversationFullId === conversationId)
  );
}

const terminalCaffySynced = new Set<string>();
const terminalCaffyPending = new Set<string>();
const terminalCaffyLastAttempt = new Map<string, number>();

/** A positive ChatGPT notice permanently fences its conversation, including after T3 restart. */
export function markChatGPTConversationFull(
  environmentId: EnvironmentId,
  sessionId: string,
  conversationId: string,
): void {
  const store = getChatGPTSessionPersistedStore(environmentId);
  const current = store.getState().sessions;
  const session = current.find((entry) => entry.id === sessionId);
  if (!session) return;
  if (session.conversationFullId !== conversationId) {
    const next = current.map((entry) =>
      entry.id === sessionId ? { ...entry, conversationFullId: conversationId } : entry,
    );
    setLocalStorageItem(chatGPTBrowserSessionsKey(environmentId), next, BrowserSessions);
    store.setState({ sessions: next });
  }
  const key = environmentId + ":" + sessionId + ":" + conversationId;
  const control = window.desktopBridge?.caffyControl;
  if (
    !control ||
    terminalCaffySynced.has(key) ||
    terminalCaffyPending.has(key) ||
    Date.now() - (terminalCaffyLastAttempt.get(key) ?? 0) < 20_000
  )
    return;
  terminalCaffyLastAttempt.set(key, Date.now());
  terminalCaffyPending.add(key);
  void control({ action: "terminal", sessionId, conversationId })
    .then((receipt) => {
      if (receipt?.ok === true) {
        terminalCaffySynced.add(key);
        window.dispatchEvent(new Event(T3_CAFFY_UPDATED_EVENT));
      }
    })
    .catch(() => {
      /* A later verified page observation retries the terminal retirement. */
    })
    .finally(() => terminalCaffyPending.delete(key));
}

export const BrowserSessions = Schema.Array(BrowserSession);
export const chatGPTBrowserSessionsKey = (environmentId: EnvironmentId | null) =>
  `t3code:chatgpt-browser:sessions:${environmentId ?? "unconnected"}`;

/** Only when a different ChatGPT conversation has replaced the current guest:
 * preserve the permanent T3 ID, then require its Bootstrap receipt again.
 * No effect on legacy sessions, and no new messages are injected. */
export function beginChatGPTBootstrapReboot(environmentId: EnvironmentId, sessionId: string): void {
  const store = getChatGPTSessionPersistedStore(environmentId);
  const current = store.getState().sessions;
  const next = current.map((entry) =>
    entry.id !== sessionId
      ? entry
      : {
          ...entry,
          conversationFullId: undefined,
          ...(entry.bootstrapIdentity
            ? { bootstrapIdentity: nextChatGPTBootstrapGeneration(entry.bootstrapIdentity) }
            : {}),
        },
  );
  if (current.every((entry, index) => entry === next[index])) return;
  setLocalStorageItem(chatGPTBrowserSessionsKey(environmentId), next, BrowserSessions);
  store.setState({ sessions: next });
}

/** Read the authoritative persisted snapshot during consecutive desktop requests. */
export function readChatGPTBrowserSessions(
  environmentId: EnvironmentId,
): readonly BrowserSession[] {
  if (typeof window === "undefined") return INITIAL_SESSIONS;
  const sessions = getChatGPTSessionPersistedStore(environmentId).getState().sessions;
  return sessions.length ? sessions : INITIAL_SESSIONS;
}
const INITIAL_SESSIONS: readonly BrowserSession[] = [{ id: "chatgpt", title: "ChatGPT 1" }];

/** Wake a snoozed slot only for a real message or qualifying activity, not a mere guest mount. */
export function wakeChatGPTBrowserSession(
  environmentId: string,
  sessionId: string,
  source: "message" | "activity" | "mount" = "message",
): void {
  const store = getChatGPTSessionPersistedStore(environmentId);
  const current = store.getState().sessions;
  const now = Date.now();
  const waking = current.find(
    (session) =>
      session.id === sessionId &&
      (session.snoozedUntil ?? 0) > now &&
      // Loading the guest alone is never proof of a new message. A quick snooze
      // also ignores incidental activity that follows the first click.
      source !== "mount" &&
      (source !== "activity" || session.quickSnoozeStep === undefined),
  );
  if (!waking) return;
  recordChatGPTWakeAudit(environmentId, sessionId, `direct:${source}`, {
    profileId: waking.profileId,
    previousUntil: waking.snoozedUntil,
    snoozedAt: waking.snoozedAt,
    quickSnoozeStep: waking.quickSnoozeStep,
  });
  const next = current.map((session) =>
    session.id === sessionId
      ? { ...session, snoozedUntil: undefined, snoozedAt: undefined, quickSnoozeStep: undefined }
      : session,
  );
  setLocalStorageItem(`t3code:chatgpt-browser:sessions:${environmentId}`, next, BrowserSessions);
  store.setState({ sessions: next });
}
// A running Caffy keeps the session snoozed until its next actual message delivery.
export const CHATGPT_CAFFY_SNOOZE_UNTIL = Date.UTC(9999, 0, 1);

function activeCaffySnooze(sessionId: string): boolean {
  const overview = readVerifiedT3CaffyOverview();
  return (
    overview?.entries.some(
      (entry) =>
        (entry.sessionId === sessionId ||
          entry.browserSessionId === sessionId ||
          entry.publicSessionId === sessionId) &&
        !entry.paused &&
        (entry.expiresAt === null || entry.expiresAt > Date.now() || !!entry.pendingMessageId),
    ) ?? false
  );
}

/** Confirm the live scheduler state, rather than relying on a possibly stale sidebar snapshot. */
function reconcileCaffySnooze(
  environmentId: EnvironmentId,
  sessionId: string,
  originalUntil: number,
  originalStep: number | undefined,
  snoozedAt: number,
): void {
  const control = typeof window === "undefined" ? null : window.desktopBridge?.caffyControl;
  if (!control) return;
  void control({ action: "status", sessionId })
    .then((readout) => {
      const caffy =
        readout &&
        typeof readout === "object" &&
        "paused" in readout &&
        typeof readout.paused === "boolean" &&
        "mode" in readout &&
        ["idle", "periodic", "startup"].includes(String(readout.mode))
          ? readout
          : null;
      const running =
        caffy &&
        !caffy.paused &&
        (!("expiresAt" in caffy) ||
          caffy.expiresAt === null ||
          (typeof caffy.expiresAt === "number" && caffy.expiresAt > Date.now()) ||
          ("pendingMessageId" in caffy && !!caffy.pendingMessageId));
      const until = running ? CHATGPT_CAFFY_SNOOZE_UNTIL : originalUntil;
      const quickSnoozeStep = running ? 0 : originalStep;
      const store = getChatGPTSessionPersistedStore(environmentId);
      const current = store.getState().sessions;
      const stillSnoozed = current.some(
        (entry) =>
          entry.id === sessionId &&
          entry.snoozedAt === snoozedAt &&
          (entry.snoozedUntil ?? 0) > Date.now() &&
          !entry.hidden,
      );
      if (!stillSnoozed) return;
      if (
        current.some(
          (entry) =>
            entry.id === sessionId &&
            (entry.snoozedUntil !== until || entry.quickSnoozeStep !== quickSnoozeStep),
        )
      ) {
        const next = current.map((entry) =>
          entry.id === sessionId ? { ...entry, snoozedUntil: until, quickSnoozeStep } : entry,
        );
        setLocalStorageItem(chatGPTBrowserSessionsKey(environmentId), next, BrowserSessions);
        store.setState({ sessions: next });
      }
      if (caffy?.paused) {
        // Paused monitors cannot wake their snoozed owner; explicitly discard them.
        void control({ action: "retire", sessionId, lifecycleReason: "snoozed" })
          .then(() => window.dispatchEvent(new Event(T3_CAFFY_UPDATED_EVENT)))
          .catch(() => {});
      }
    })
    .catch(() => {
      // Scheduler reconciliation handles paused monitors if IPC is briefly unavailable.
    });
}

/** Inform the desktop-owned scheduler after terminal local lifecycle changes. */
function retireChatGPTCaffy(sessionId: string, lifecycleReason: "closed" | "hidden") {
  const control = typeof window === "undefined" ? null : window.desktopBridge?.caffyControl;
  if (!control) return;
  void control({ action: "retire", sessionId, lifecycleReason }).catch(() => {
    // The desktop scheduler independently reconciles complete inventories.
    // Local close/hide must not be rolled back by an IPC outage.
  });
}
const DEFAULT_SESSION_TITLE = /^ChatGPT \d+$/;
// Delivery markers belong to the conversation's messages, not its sidebar title.
const DELIVERY_TITLE_MARKER = /^\s*\[T3-MSG:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\]\s*/i;
export function cleanChatGPTSessionTitle(title: string): string {
  return title.replace(DELIVERY_TITLE_MARKER, "").trim();
}

export function chatGPTSessionTitleFromPage(pageTitle: string | null): string | null {
  const title = cleanChatGPTSessionTitle(
    (pageTitle ?? "")
      .trim()
      .replace(/\s+[-–—|]\s+(?:ChatGPT|OpenAI)$/i, "")
      .replace(/^ChatGPT\s+[-–—|]\s+/i, ""),
  );
  if (!title || /^(?:ChatGPT(?: \d+)?|New chat|Temporary chat|OpenAI)$/i.test(title)) {
    return null;
  }
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
}

/** Clean previously saved automatic titles as well as new ChatGPT page titles.
 * Explicit manual and Bootstrap titles remain authoritative. */
export function updateChatGPTAutoTitle(
  session: BrowserSession,
  pageTitle: string | null,
): BrowserSession {
  if (session.titleSource === "user" || session.titleSource === "bootstrap") return session;
  const cleaned = cleanChatGPTSessionTitle(session.title);
  if (cleaned !== session.title) {
    return {
      ...session,
      title: cleaned || chatGPTSessionTitleFromPage(pageTitle) || "ChatGPT session",
    };
  }
  const proposed = chatGPTSessionTitleFromPage(pageTitle);
  return proposed && DEFAULT_SESSION_TITLE.test(session.title)
    ? { ...session, title: proposed }
    : session;
}

export const CHATGPT_DEFAULT_URL = "https://chatgpt.com";

/** Resolve exact persisted conversation ownership; never infer it from titles or T3 session IDs. */
export function findExistingChatGPTConversation(
  sessions: readonly BrowserSession[],
  targetUrl: string,
  readUrl: (sessionId: string) => string | null,
): BrowserSession | undefined {
  const id = chatGPTConversationIdFromUrl(targetUrl);
  if (!id || !CANONICAL_CHATGPT_CONVERSATION_ID.test(id)) return undefined;
  return sessions.find(
    (session) =>
      chatGPTConversationIdFromUrl(
        readUrl(session.id) ?? session.archive?.conversationUrl ?? null,
      ) === id,
  );
}

export function isChatGPTConversationUrl(url: string | null): boolean {
  return chatGPTConversationIdFromUrl(url) !== null;
}

export const chatGPTBrowserLastUrlKey = (environmentId: EnvironmentId, sessionId: string) =>
  sessionId === "chatgpt"
    ? `t3code:chatgpt-browser:last-url:${environmentId}`
    : `t3code:chatgpt-browser:last-url:${environmentId}:${sessionId}`;

export const chatGPTBrowserLastWorkingKey = (environmentId: EnvironmentId, sessionId: string) =>
  `t3code:chatgpt-browser:last-working:${environmentId}:${sessionId}`;

export const chatGPTBrowserRemovalAuditKey = (environmentId: EnvironmentId) =>
  `t3code:chatgpt-browser:removal-audit:v1:${environmentId}`;

export type ChatGPTSessionRemovalSource =
  | "sidebar-user-action"
  | "desktop-menu-action"
  | "desktop-IPC-request"
  | "expiration"
  | "unused-empty-manual"
  | "completed-worker"
  | "unknown";

export type ChatGPTSessionRemovalReceipt = {
  readonly version: 1;
  readonly sessionId: string;
  readonly removedAt: string;
  readonly title: string;
  readonly parentSessionId: string | null | "UNKNOWN";
  readonly conversationId: string | null;
  readonly source: ChatGPTSessionRemovalSource;
  // A UI click or desktop IPC request is not proof of the actual human caller.
  readonly authenticatedCaller: "UNKNOWN";
  readonly draftSafetyVerified: false;
  readonly completionVerified: false;
  readonly persistence: "local-session-list-verified";
};

const MAX_REMOVAL_RECEIPTS = 128;

/** Merge idempotently by the removed local UUID. Oldest entries rotate at the cap. */
export function mergeChatGPTSessionRemovalReceipts(
  current: readonly ChatGPTSessionRemovalReceipt[],
  receipt: ChatGPTSessionRemovalReceipt,
): ChatGPTSessionRemovalReceipt[] {
  if (current.some((entry) => entry.sessionId === receipt.sessionId)) return [...current];
  return [...current, receipt].slice(-MAX_REMOVAL_RECEIPTS);
}

/**
 * Evidence is limited to a verified change in T3's locally persisted session
 * index. It does not prove guest deletion, safe drafts, completion, or a user's
 * identity. Never load or navigate a guest to infer its conversation identity.
 */
function recordPersistedChatGPTSessionRemoval(
  environmentId: EnvironmentId | null,
  entry: BrowserSession | undefined,
  source: ChatGPTSessionRemovalSource,
): void {
  if (!environmentId || !entry) return;
  try {
    if (readChatGPTBrowserSessions(environmentId).some((saved) => saved.id === entry.id)) return;
    const key = chatGPTBrowserRemovalAuditKey(environmentId);
    const storage = window.localStorage;
    const raw = storage.getItem(key);
    const decoded: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(decoded)) throw new Error("Invalid removal journal.");
    // Never replace corrupt historical evidence or accidentally copy other data.
    if (decoded.some((value) => !isChatGPTSessionRemovalReceipt(value)))
      throw new Error("Invalid removal journal receipt.");
    const existing = decoded as ChatGPTSessionRemovalReceipt[];
    if (existing.some((value) => value.sessionId === entry.id)) return;
    let cachedUrl: string | null = null;
    try {
      cachedUrl = getLocalStorageItem(
        chatGPTBrowserLastUrlKey(environmentId, entry.id),
        Schema.String,
      );
    } catch {
      // A missing/invalid cached URL is not evidence of a particular conversation.
    }
    const receipt: ChatGPTSessionRemovalReceipt = {
      version: 1,
      sessionId: entry.id,
      removedAt: new Date().toISOString(),
      title: entry.title,
      parentSessionId: entry.parentSessionId === undefined ? "UNKNOWN" : entry.parentSessionId,
      conversationId: chatGPTConversationIdFromUrl(
        cachedUrl ?? entry.archive?.conversationUrl ?? null,
      ),
      source,
      authenticatedCaller: "UNKNOWN",
      draftSafetyVerified: false,
      completionVerified: false,
      persistence: "local-session-list-verified",
    };
    const updated = JSON.stringify(mergeChatGPTSessionRemovalReceipts(existing, receipt));
    storage.setItem(key, updated);
    if (storage.getItem(key) !== updated) throw new Error("Removal journal write did not persist.");
  } catch {
    // Audit is best-effort, never a reason to change an existing close/save flow.
    console.warn("[ChatGPT removal audit] Could not persist local removal provenance.");
  }
}

function isChatGPTSessionRemovalReceipt(value: unknown): value is ChatGPTSessionRemovalReceipt {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ChatGPTSessionRemovalReceipt>;
  // Never round-trip unknown fields from a corrupted or externally modified
  // journal: an extra field could otherwise smuggle message or draft content.
  if (
    Object.keys(value).sort().join(",") !==
    "authenticatedCaller,completionVerified,conversationId,draftSafetyVerified,parentSessionId,persistence,removedAt,sessionId,source,title,version"
  )
    return false;
  return (
    entry.version === 1 &&
    typeof entry.sessionId === "string" &&
    typeof entry.removedAt === "string" &&
    typeof entry.title === "string" &&
    (typeof entry.parentSessionId === "string" || entry.parentSessionId === null) &&
    (typeof entry.conversationId === "string" || entry.conversationId === null) &&
    (entry.source === "sidebar-user-action" ||
      entry.source === "desktop-menu-action" ||
      entry.source === "desktop-IPC-request" ||
      entry.source === "expiration" ||
      entry.source === "unused-empty-manual" ||
      entry.source === "completed-worker" ||
      entry.source === "unknown") &&
    entry.authenticatedCaller === "UNKNOWN" &&
    entry.draftSafetyVerified === false &&
    entry.completionVerified === false &&
    entry.persistence === "local-session-list-verified"
  );
}

// Preview uses this owner only to group tabs; no agent conversation is created.
export const chatGPTBrowserThreadRef = (environmentId: EnvironmentId, sessionId: string) =>
  scopeThreadRef(environmentId, ThreadId.make(`t3-browser-session:${sessionId}`));

/** Accept a bounded, explicitly rendered agent title once; a manual F2/menu
 * rename is authoritative and is never replaced by future Bootstrap calls. */
export function applyChatGPTBootstrapTitle(
  session: BrowserSession,
  proposedTitle: string | undefined,
): BrowserSession {
  if (
    session.titleSource === "user" ||
    session.titleSource === "bootstrap" ||
    typeof proposedTitle !== "string"
  )
    return session;
  if (/[\[\]\x00-\x1f\x7f]/u.test(proposedTitle)) return session;
  const title = proposedTitle.trim().replace(/\s+/gu, " ");
  if (title.length < 3 || title.length > 80) return session;
  return { ...session, title, titleSource: "bootstrap" };
}

/** OMCPT may propose a title directly for a preassigned backend seat;
 * it cannot create or rename arbitrary sessions using a claimed UUID. */
export function applyPreassignedChatGPTBootstrapTitle(
  session: BrowserSession,
  claimedId: string,
  proposedTitle: string,
): BrowserSession {
  if (
    !session.spawnRequestId ||
    session.id !== claimedId ||
    session.bootstrapIdentity?.publicId !== claimedId
  )
    return session;
  return applyChatGPTBootstrapTitle(session, proposedTitle);
}

/** A streamed ID may be visible before the next paragraph contains its title.
 * Register the ID immediately, then accept only the adjacent title from the
 * same conversation/ID while the brief pending window is open. */
export function applyChatGPTBootstrapObservation(
  sessions: readonly BrowserSession[],
  id: string,
  observation: ChatGPTBootstrapObservation,
): readonly BrowserSession[] {
  const updated = registerChatGPTBootstrapMarker(sessions, id, observation);
  const entry = updated ?? sessions.find((session) => session.id === id);
  if (!entry) return sessions;
  const identity = entry.bootstrapIdentity;
  const samePendingReply =
    !updated &&
    identity?.state === "registered" &&
    (identity.titlePendingUntil ?? 0) > Date.now() &&
    identity.publicId?.toLowerCase() === observation.markerId.toLowerCase() &&
    identity.conversationId === observation.conversationId;
  if (!updated && !samePendingReply) return sessions;
  const titled =
    identity?.state === "registered" && (updated || samePendingReply)
      ? applyChatGPTBootstrapTitle(entry, observation.proposedTitle)
      : entry;
  const next =
    titled !== entry && identity?.titlePendingUntil
      ? { ...titled, bootstrapIdentity: { ...identity, titlePendingUntil: undefined } }
      : titled;
  if (next === sessions.find((session) => session.id === id)) return sessions;
  return sessions.map((session) => (session.id === id ? next : session));
}

/** Apply a durable Bootstrap title only after this exact assistant marker has
 * registered the public ID against the current conversation. */
export function applyChatGPTBootstrapRegistryTitle(
  sessions: readonly BrowserSession[],
  id: string,
  markerId: string,
  conversationId: string,
  title: string | null,
): readonly BrowserSession[] {
  if (!title) return sessions;
  const session = sessions.find((entry) => entry.id === id);
  if (
    session?.bootstrapIdentity?.state !== "registered" ||
    session.bootstrapIdentity.publicId?.toLowerCase() !== markerId.toLowerCase() ||
    session.bootstrapIdentity.conversationId !== conversationId
  )
    return sessions;
  const next = applyChatGPTBootstrapTitle(session, title);
  return next === session ? sessions : sessions.map((entry) => (entry.id === id ? next : entry));
}

/** Move a session within its visible or hidden section without changing the other section. */
export function reorderChatGPTSessions(
  sessions: readonly BrowserSession[],
  movingId: string,
  overId: string,
): BrowserSession[] {
  const from = sessions.findIndex((session) => session.id === movingId);
  const to = sessions.findIndex((session) => session.id === overId);
  if (from === -1 || to === -1 || from === to) return [...sessions];
  const hidden = sessions[from]?.hidden === true;
  if ((sessions[to]?.hidden === true) !== hidden) return [...sessions];
  const sectionIndices = sessions.flatMap((session, index) =>
    (session.hidden === true) === hidden ? [index] : [],
  );
  const section = sectionIndices.map((index) => sessions[index]!);
  const source = section.findIndex((session) => session.id === movingId);
  const target = section.findIndex((session) => session.id === overId);
  if (source === -1 || target === -1) return [...sessions];
  const [removed] = section.splice(source, 1);
  section.splice(target, 0, removed!);
  const reordered = [...sessions];
  sectionIndices.forEach((index, position) => {
    reordered[index] = section[position]!;
  });
  return reordered;
}

/**
 * A sidebar project drag moves the linked ChatGPT subtree as one unit.
 * Keep existing session order/guest state and child links; only the dragged
 * root detaches from its old parent. A visited set bounds corrupt cycles.
 */
export function moveChatGPTSessionProject(
  sessions: readonly BrowserSession[],
  id: string,
  project: string | null,
): BrowserSession[] {
  if (!sessions.some((session) => session.id === id)) return [...sessions];

  const children = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const siblings = children.get(session.parentSessionId) ?? [];
    siblings.push(session.id);
    children.set(session.parentSessionId, siblings);
  }

  const moving = new Set([id]);
  const pending = [id];
  while (pending.length) {
    for (const childId of children.get(pending.pop()!) ?? []) {
      if (moving.has(childId)) continue;
      moving.add(childId);
      pending.push(childId);
    }
  }

  const target = project ?? "Other";
  return sessions.map((session) =>
    !moving.has(session.id)
      ? session
      : session.id === id
        ? { ...session, project: target, parentSessionId: null }
        : { ...session, project: target },
  );
}

/** Hiding prepends to the hidden list; restoring appends to the live list. */
export function setChatGPTSessionHidden(
  sessions: readonly BrowserSession[],
  id: string,
  hidden: boolean,
): BrowserSession[] {
  const target = sessions.find((session) => session.id === id);
  if (!target || (target.hidden === true) === hidden) return [...sessions];

  const remaining = sessions.filter((session) => session.id !== id);
  const visible = remaining.filter((session) => session.hidden !== true);
  const hiddenSessions = remaining.filter((session) => session.hidden === true);
  const updated = {
    ...target,
    hidden,
    hiddenAt: hidden ? Date.now() : undefined,
    ...(target.archive && !hidden
      ? { archive: { ...target.archive, restoredAt: new Date().toISOString() } }
      : {}),
  };
  return [...visible, updated, ...hiddenSessions];
}

/** An archive is a durable, restorable session record, not an expiring sidebar hide. */
export function setChatGPTSessionArchived(
  sessions: readonly BrowserSession[],
  id: string,
  archive: NonNullable<BrowserSession["archive"]>,
): BrowserSession[] {
  const entry = sessions.find((session) => session.id === id);
  if (!entry) return [...sessions];
  if (entry.hidden && entry.archive && !entry.archive.restoredAt) return [...sessions];
  const visible = sessions.filter((session) => session.id !== id && !session.hidden);
  const hidden = sessions.filter((session) => session.id !== id && session.hidden);
  return [...visible, { ...entry, hidden: true, hiddenAt: Date.now(), archive }, ...hidden];
}

export const CHATGPT_HIDDEN_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000;

/** Unknown legacy hide times are never treated as expired. */
export function expiredHiddenSessionIds(
  sessions: readonly BrowserSession[],
  now: number,
  protectedIds: ReadonlySet<string> = new Set(),
): string[] {
  return sessions
    .filter(
      (session) =>
        session.hidden === true &&
        !protectedIds.has(session.id) &&
        // A manager archive survives indefinitely; only a plain UI hide expires.
        !(session.archive && !session.archive.restoredAt) &&
        typeof session.hiddenAt === "number" &&
        Number.isFinite(session.hiddenAt) &&
        session.hiddenAt > 0 &&
        now - session.hiddenAt >= CHATGPT_HIDDEN_EXPIRY_MS,
    )
    .map((session) => session.id);
}

export function useChatGPTBrowserSessions(environmentId: EnvironmentId | null) {
  const sessionStore = getChatGPTSessionPersistedStore(environmentId ?? "unconnected");
  const storedSessions = useStore(sessionStore, (state) => state.sessions);
  const sessions = storedSessions.length ? storedSessions : INITIAL_SESSIONS;
  const setSessions = useCallback(
    (
      update:
        | readonly BrowserSession[]
        | ((current: readonly BrowserSession[]) => readonly BrowserSession[]),
    ) => {
      const current = sessionStore.getState().sessions;
      const proposed =
        typeof update === "function" ? update(current.length ? current : INITIAL_SESSIONS) : update;
      if (proposed === current) return;
      // A second renderer may still hold a snapshot from before a close.
      const next = filterClosedChatGPTSessions(
        environmentId ?? "unconnected",
        proposed,
        window.localStorage,
      );
      setLocalStorageItem(chatGPTBrowserSessionsKey(environmentId), next, BrowserSessions);
      sessionStore.setState({ sessions: next });
    },
    [sessionStore, environmentId],
  );
  const [prewarmedSessionId, setPrewarmedSessionId] = useLocalStorage(
    chatGPTPrewarmKey(environmentId ?? "unconnected"),
    "",
    Schema.String,
  );

  const createSession = useCallback(
    (
      name?: string,
      metadata?: {
        parentSessionId?: string;
        project?: string;
        initialConversationUrl?: string;
        spawnRequestId?: string;
        autoClose?: boolean;
        explicitlyUserCreated?: boolean;
        /** Explicit profile for a new manual session; ignored for backend workers. */
        profileId?: string;
        binding?: ChatGPTSessionBinding;
      },
    ) => {
      // Opening a known /c/ conversation reuses the original T3 identity.
      // Do not replace the guest or its composer draft, even for hidden/snoozed owners.
      if (environmentId && metadata?.initialConversationUrl && !metadata.spawnRequestId) {
        const requestedId = chatGPTConversationIdFromUrl(metadata.initialConversationUrl);
        if (
          !requestedId ||
          metadata.initialConversationUrl !== `https://chatgpt.com/c/${requestedId}`
        )
          throw new Error("Only an exact canonical ChatGPT conversation URL may seed a session.");
        const owner = findExistingChatGPTConversation(
          readChatGPTBrowserSessions(environmentId).filter(
            (session) =>
              !metadata.profileId ||
              (session.profileId ?? PRIMARY_CHATGPT_PROFILE_ID) === metadata.profileId,
          ),
          metadata.initialConversationUrl,
          (id) => getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, id), Schema.String),
        );
        if (owner) {
          setSessions((current) =>
            current.map((session) =>
              session.id === owner.id
                ? {
                    ...session,
                    hidden: false,
                    hiddenAt: undefined,
                    snoozedUntil: undefined,
                    ...(session.archive
                      ? {
                          archive: { ...session.archive, restoredAt: new Date().toISOString() },
                        }
                      : {}),
                  }
                : session,
            ),
          );
          return owner.id;
        }
      }
      const profileId = metadata?.spawnRequestId
        ? PRIMARY_CHATGPT_PROFILE_ID
        : (metadata?.profileId ??
          (metadata?.explicitlyUserCreated && !metadata?.initialConversationUrl
            ? readNewChatGPTProfileId(environmentId)
            : PRIMARY_CHATGPT_PROFILE_ID));
      let id = randomUUID();
      // Read the current slot synchronously: multiple buttons, the palette and
      // desktop automation can request sessions without waiting for a render.
      // A warm spare belongs only to an explicit human UI action. Backend or
      // unspecified callers always receive a fresh UUID/guest, even without a receipt.
      if (
        environmentId &&
        metadata?.explicitlyUserCreated === true &&
        profileId === PRIMARY_CHATGPT_PROFILE_ID &&
        !metadata.initialConversationUrl &&
        !metadata.spawnRequestId
      ) {
        const spareId = getLocalStorageItem(chatGPTPrewarmKey(environmentId), Schema.String);
        if (spareId) {
          const threadRef = chatGPTBrowserThreadRef(environmentId, spareId);
          const state = readThreadPreviewState(threadRef);
          const tabId = state.activeTabId;
          const nav = tabId ? state.sessions[tabId]?.navStatus : null;
          const overlay = tabId ? state.desktopByTabId[tabId] : null;
          const attached =
            !!tabId &&
            !!state.serverEpoch &&
            Array.from(document.querySelectorAll("webview")).some(
              (element) =>
                element.dataset.previewTab ===
                previewRuntimeTabId(threadRef, state.serverEpoch, tabId),
            );
          // A native spare is owned by Electron, not a preview-tab webview.
          // Only a ready, unconsumed spare is eligible for manual new chats.
          const nativeSpare = isPersistentChatGPTSessionOptedIn(spareId);
          const legacySpareReady =
            nav?._tag === "Success" &&
            isChatGPTHomeUrl(nav.url) &&
            overlay?.hasWebContents &&
            !overlay.loading &&
            attached;
          if (
            !sessions.some((session) => session.id === spareId) &&
            (nativeSpare || legacySpareReady) &&
            takeChatGPTSpare(environmentId, spareId)
          ) {
            id = spareId;
            // The consumed webview remains mounted under its original preview
            // owner; replenishment gets a different owner and a fresh page.
            setPrewarmedSessionId(randomUUID());
          }
        }
      }
      // Routing an existing /c/<id> must not reuse a prewarmed homepage: its
      // attached guest would ignore the initial URL and might receive a prompt
      // in a different conversation. Seed the new owner before it is mounted.
      if (environmentId && metadata?.initialConversationUrl) {
        const idInUrl = chatGPTConversationIdFromUrl(metadata.initialConversationUrl);
        if (!idInUrl || metadata.initialConversationUrl !== `https://chatgpt.com/c/${idInUrl}`)
          throw new Error("Only an exact canonical ChatGPT conversation URL may seed a session.");
        setLocalStorageItem(
          chatGPTBrowserLastUrlKey(environmentId, id),
          metadata.initialConversationUrl,
          Schema.String,
        );
      }
      const createdAt = Date.now();
      setSessions((current) => {
        let number = 1;
        while (current.some((session) => session.title === `ChatGPT ${number}`)) number += 1;
        return [
          ...current,
          {
            id,
            profileId,
            title: cleanChatGPTSessionTitle(name ?? "") || `ChatGPT ${number}`,
            createdAt,
            ...(!metadata?.initialConversationUrl ? { initialHighEffortPending: true } : {}),
            ...(metadata?.spawnRequestId
              ? {
                  creationOrigin: "backend" as const,
                  spawnRequestId: metadata.spawnRequestId,
                  bootstrapIdentity: { state: "awaiting_marker" as const, publicId: id },
                }
              : metadata?.explicitlyUserCreated && !metadata.initialConversationUrl
                ? {
                    creationOrigin: "manual" as const,
                    bootstrapIdentity: { state: "awaiting_marker" as const },
                  }
                : {}),
            ...(metadata?.explicitlyUserCreated &&
            !name &&
            !metadata.initialConversationUrl &&
            !metadata.spawnRequestId &&
            !metadata.parentSessionId &&
            !metadata.project
              ? { manualEmptyCandidateCreatedAt: Date.now() }
              : {}),
            ...(metadata?.binding ? { binding: metadata.binding } : {}),
            ...(metadata?.parentSessionId
              ? { parentSessionId: metadata.parentSessionId }
              : metadata?.binding
                ? { parentSessionId: metadata.binding.parentSessionId }
                : {}),
            ...(metadata?.project ? { project: metadata.project } : {}),
            ...(metadata?.spawnRequestId && metadata.autoClose === true ? { autoClose: true } : {}),
          },
        ];
      });
      // The selected profile was captured above for this session. After a
      // successful manual creation, make the NEXT chat default to blue.
      if (metadata?.explicitlyUserCreated && !metadata.spawnRequestId) {
        resetNewChatGPTProfileId(environmentId);
      }
      return id;
    },
    [environmentId, sessions, setPrewarmedSessionId, setSessions],
  );

  /** OMCPT title proposals target only an existing preassigned backend seat.
   * Never create a session, infer by tab focus, or touch a user-renamed title. */
  const suggestBootstrapTitle = useCallback(
    (id: string, title: string) => {
      let accepted = false;
      setSessions((current) =>
        current.map((session) => {
          const next = applyPreassignedChatGPTBootstrapTitle(session, id, title);
          if (
            next !== session ||
            (session.titleSource === "bootstrap" && session.title === title)
          ) {
            accepted = true;
          }
          return next;
        }),
      );
      return accepted;
    },
    [setSessions],
  );

  const registerBootstrapMarker = useCallback(
    (id: string, observation: ChatGPTBootstrapObservation) =>
      setSessions((current) => applyChatGPTBootstrapObservation(current, id, observation)),
    [setSessions],
  );

  const resolveBootstrapTitle = useCallback(
    (id: string, markerId: string, conversationId: string, title: string | null) =>
      setSessions((current) =>
        applyChatGPTBootstrapRegistryTitle(current, id, markerId, conversationId, title),
      ),
    [setSessions],
  );

  const disqualifyManualEmptyCandidate = useCallback(
    (id: string) =>
      setSessions((current) => {
        if (
          !current.some(
            (session) =>
              session.id === id &&
              session.manualEmptyCandidateCreatedAt &&
              !session.manualEmptyCandidateDisqualified,
          )
        )
          return current;
        return current.map((session) =>
          session.id === id ? { ...session, manualEmptyCandidateDisqualified: true } : session,
        );
      }),
    [setSessions],
  );

  const setSessionCompletion = useCallback(
    (id: string, completion: BrowserSession["completion"] | undefined) => {
      setSessions((current) =>
        current.map((session) => (session.id === id ? { ...session, completion } : session)),
      );
    },
    [setSessions],
  );

  const finalizeRollover = useCallback(
    (plan: ChatGPTRolloverPlan) => {
      setSessions((current) => finalizeChatGPTRolloverHierarchy(current, plan));
      retireChatGPTCaffy(plan.priorId, "hidden");
    },
    [setSessions],
  );

  const setSessionParent = useCallback(
    (id: string, parentId: string | null) => {
      setSessions((current) => {
        if (parentId === id) return current;
        const byId = new Map(current.map((entry) => [entry.id, entry]));
        if (parentId && !byId.has(parentId)) return current;
        let cursor = parentId;
        const seen = new Set<string>();
        while (cursor) {
          if (cursor === id || seen.has(cursor)) return current;
          seen.add(cursor);
          cursor = byId.get(cursor)?.parentSessionId ?? null;
        }
        return current.map((session) =>
          session.id === id
            ? {
                ...session,
                parentSessionId: parentId,
                ...(session.binding
                  ? {
                      binding: {
                        ...session.binding,
                        parentSessionId: parentId,
                        boundAt: new Date().toISOString(),
                        boundBy: "user" as const,
                      },
                    }
                  : {}),
                project: parentId
                  ? (byId.get(parentId)?.project ?? session.project)
                  : session.project,
              }
            : session,
        );
      });
    },
    [setSessions],
  );

  const setSessionBinding = useCallback(
    (id: string, binding: ChatGPTSessionBinding | null) => {
      setSessions((current) => {
        const entry = current.find((session) => session.id === id);
        if (!entry) return current;
        if (
          binding?.parentSessionId === id ||
          (binding?.parentSessionId &&
            !current.some((session) => session.id === binding.parentSessionId))
        )
          return current;
        let cursor = binding?.parentSessionId ?? null;
        const visited = new Set<string>();
        while (cursor) {
          if (cursor === id || visited.has(cursor)) return current;
          visited.add(cursor);
          cursor = current.find((session) => session.id === cursor)?.parentSessionId ?? null;
        }
        return current.map((session) =>
          session.id === id
            ? {
                ...session,
                binding: binding ?? undefined,
                ...(binding ? { parentSessionId: binding.parentSessionId } : {}),
              }
            : session,
        );
      });
    },
    [setSessions],
  );

  const setSessionProject = useCallback(
    (id: string, project: string | null) =>
      setSessions((current) => moveChatGPTSessionProject(current, id, project)),
    [setSessions],
  );

  const setSessionSnooze = useCallback(
    (ids: readonly string[], until: number | null) => {
      const targets = new Set(ids);
      const caffyIds = until === null ? new Set<string>() : new Set(ids.filter(activeCaffySnooze));
      const snoozedAt = Date.now();
      if (environmentId) {
        for (const session of readChatGPTBrowserSessions(environmentId)) {
          if (!targets.has(session.id)) continue;
          recordChatGPTWakeAudit(
            environmentId,
            session.id,
            until === null ? "setSessionSnooze:clear" : "setSessionSnooze:set",
            {
              profileId: session.profileId,
              previousUntil: session.snoozedUntil,
              nextUntil:
                until === null
                  ? undefined
                  : caffyIds.has(session.id)
                    ? CHATGPT_CAFFY_SNOOZE_UNTIL
                    : until,
              snoozedAt: session.snoozedAt,
              quickSnoozeStep: session.quickSnoozeStep,
            },
          );
        }
      }
      if (until !== null) {
        for (const id of ids) {
          if (environmentId)
            clearChatGPTGuestUserOpened(
              JSON.stringify([environmentId, chatGPTBrowserThreadRef(environmentId, id).threadId]),
            );
          clearChatGPTGuestUserOpened(id);
        }
      }
      setSessions((current) =>
        current.map((session) =>
          targets.has(session.id)
            ? {
                ...session,
                snoozedUntil:
                  until === null
                    ? undefined
                    : caffyIds.has(session.id)
                      ? CHATGPT_CAFFY_SNOOZE_UNTIL
                      : until,
                snoozedAt: until === null ? undefined : snoozedAt,
                quickSnoozeStep: caffyIds.has(session.id) ? 0 : undefined,
                autoCloseExempt: session.autoCloseExempt === true || until !== null,
              }
            : session,
        ),
      );
      if (environmentId && until !== null && until > snoozedAt)
        for (const id of ids) reconcileCaffySnooze(environmentId, id, until, undefined, snoozedAt);
    },
    [environmentId, setSessions],
  );

  const setSessionVerification = useCallback(
    (id: string, pending: boolean) => {
      const markedAt = Date.now();
      setSessions((current) =>
        current.map((session) =>
          session.id === id
            ? {
                ...session,
                verificationPending: pending || undefined,
                // Repeated Mark calls must not move an already queued item.
                verificationMarkedAt: pending
                  ? session.verificationPending
                    ? session.verificationMarkedAt
                    : markedAt
                  : undefined,
                snoozedUntil: pending
                  ? Math.max(session.snoozedUntil ?? 0, markedAt + 60 * 60_000)
                  : session.snoozedUntil,
                snoozedAt: pending ? (session.snoozedAt ?? markedAt) : session.snoozedAt,
                quickSnoozeStep: pending ? (session.quickSnoozeStep ?? 0) : session.quickSnoozeStep,
                autoCloseExempt: true,
              }
            : session,
        ),
      );
    },
    [setSessions],
  );
  const quickSnoozeSession = useCallback(
    (id: string, until: number, step: number) => {
      const snoozedAt = Date.now();
      const caffySnooze = activeCaffySnooze(id);
      if (environmentId) {
        const previous = readChatGPTBrowserSessions(environmentId).find(
          (session) => session.id === id,
        );
        if (previous)
          recordChatGPTWakeAudit(environmentId, id, "quickSnooze:set", {
            profileId: previous.profileId,
            previousUntil: previous.snoozedUntil,
            nextUntil: caffySnooze ? CHATGPT_CAFFY_SNOOZE_UNTIL : until,
            snoozedAt: previous.snoozedAt,
            quickSnoozeStep: previous.quickSnoozeStep,
          });
      }
      if (environmentId)
        clearChatGPTGuestUserOpened(
          JSON.stringify([environmentId, chatGPTBrowserThreadRef(environmentId, id).threadId]),
        );
      clearChatGPTGuestUserOpened(id);
      setSessions((current) =>
        current.map((session) =>
          session.id === id
            ? {
                ...session,
                snoozedUntil: caffySnooze ? CHATGPT_CAFFY_SNOOZE_UNTIL : until,
                snoozedAt,
                quickSnoozeStep: step,
                autoCloseExempt: true,
              }
            : session,
        ),
      );
      if (environmentId && until > snoozedAt)
        reconcileCaffySnooze(environmentId, id, until, step, snoozedAt);
    },
    [environmentId, setSessions],
  );
  const resetQuickSnooze = useCallback(
    (id: string) =>
      setSessions((current) =>
        !current.some((session) => session.id === id && session.quickSnoozeStep !== undefined)
          ? current
          : current.map((session) =>
              session.id === id && session.quickSnoozeStep !== undefined
                ? { ...session, quickSnoozeStep: undefined }
                : session,
            ),
      ),
    [setSessions],
  );
  const setSessionBorderColor = useCallback(
    (id: string, color: string | null) =>
      setSessions((current) =>
        current.map((session) =>
          session.id === id
            ? {
                ...session,
                borderColor: color ?? undefined,
                humanControlled: session.humanControlled === true || color !== null,
                autoCloseExempt: session.autoCloseExempt === true || color !== null,
              }
            : session,
        ),
      ),
    [setSessions],
  );

  const toggleSessionReturnMarker = useCallback(
    (id: string, activity: "idle" | "working" | "unknown") =>
      setSessions((current) =>
        current.map((session) =>
          session.id !== id
            ? session
            : {
                ...session,
                returnMarker: session.returnMarker
                  ? undefined
                  : activity === "working"
                    ? "working"
                    : "armed",
                snoozedUntil: undefined,
                snoozedAt: undefined,
              },
        ),
      ),
    [setSessions],
  );

  const clearSessionReturnMarker = useCallback(
    (id: string) =>
      setSessions((current) =>
        current.some((session) => session.id === id && session.returnMarker)
          ? current.map((session) =>
              session.id === id ? { ...session, returnMarker: undefined } : session,
            )
          : current,
      ),
    [setSessions],
  );

  const observeSessionReturnMarker = useCallback(
    (id: string, age: "working" | "recent" | "inactive" | "unknown") =>
      setSessions((current) => {
        const entry = current.find((session) => session.id === id);
        if (!entry?.returnMarker) return current;
        const next = advanceChatGPTReturnMarker(entry.returnMarker, age);
        if (next === entry.returnMarker) return current;
        return current.map((session) =>
          session.id === id ? { ...session, returnMarker: next } : session,
        );
      }),
    [setSessions],
  );

  const markHumanControlled = useCallback(
    (id: string) =>
      setSessions((current) =>
        current.map((session) =>
          session.id === id && !session.humanControlled
            ? { ...session, humanControlled: true, autoCloseExempt: true }
            : session,
        ),
      ),
    [setSessions],
  );

  const markDirectInteraction = useCallback(
    (id: string, at = Date.now()) => {
      setSessions((current) =>
        current.map((session) =>
          session.id === id && at > (session.lastDirectInteractionAt ?? 0)
            ? { ...session, lastDirectInteractionAt: at }
            : session,
        ),
      );
    },
    [setSessions],
  );

  const syncInferredMetadata = useCallback(
    (
      updates: ReadonlyArray<{
        readonly id: string;
        readonly project?: string | undefined;
        readonly parentSessionId?: string | undefined;
      }>,
    ) => {
      const byId = new Map(updates.map((entry) => [entry.id, entry]));
      setSessions((current) => {
        let changed = false;
        const next = current.map((session) => {
          const update = byId.get(session.id);
          if (!update) return session;
          const project = session.project ?? update.project;
          const parentSessionId =
            session.parentSessionId === undefined
              ? update.parentSessionId
              : session.parentSessionId;
          if (project === session.project && parentSessionId === session.parentSessionId)
            return session;
          changed = true;
          return {
            ...session,
            ...(project ? { project } : {}),
            ...(parentSessionId ? { parentSessionId } : {}),
          };
        });
        return changed ? next : current;
      });
    },
    [setSessions],
  );

  const pruneExpiredHidden = useCallback(
    (now: number, protectedIds: ReadonlySet<string> = new Set()) => {
      const expired = expiredHiddenSessionIds(sessions, now, protectedIds);
      if (!expired.length) return [] as string[];
      const ids = new Set(expired);
      let removed: BrowserSession[] = [];
      setSessions((current) => {
        removed = current.filter((session) => ids.has(session.id));
        return current
          .filter((session) => !ids.has(session.id))
          .map((session) =>
            session.parentSessionId && ids.has(session.parentSessionId)
              ? { ...session, parentSessionId: null }
              : session,
          );
      });
      for (const entry of removed) {
        recordPersistedChatGPTSessionRemoval(environmentId, entry, "expiration");
        retireChatGPTCaffy(entry.id, "closed");
      }
      return expired;
    },
    [environmentId, sessions, setSessions],
  );

  const renameSession = useCallback(
    (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      setSessions((current) =>
        current.map((session) =>
          session.id === id
            ? { ...session, title: trimmed, titleSource: "user" as const }
            : session,
        ),
      );
    },
    [setSessions],
  );

  const renameSessionFromPageTitle = useCallback(
    (id: string, pageTitle: string | null) => {
      if (!chatGPTSessionTitleFromPage(pageTitle)) return;
      setSessions((current) =>
        current.map((session) =>
          session.id === id ? updateChatGPTAutoTitle(session, pageTitle) : session,
        ),
      );
    },
    [setSessions],
  );

  const removeSession = useCallback(
    (id: string, source: ChatGPTSessionRemovalSource = "unknown") => {
      let removed: BrowserSession | undefined;
      setSessions((current) => {
        removed = current.find((session) => session.id === id);
        return current
          .filter((session) => session.id !== id)
          .map((session) =>
            session.parentSessionId === id ? { ...session, parentSessionId: null } : session,
          );
      });
      recordPersistedChatGPTSessionRemoval(environmentId, removed, source);
      if (removed) retireChatGPTCaffy(removed.id, "closed");
    },
    [environmentId, setSessions],
  );

  const reorderSessions = useCallback(
    (movingId: string, overId: string) =>
      setSessions((current) => reorderChatGPTSessions(current, movingId, overId)),
    [setSessions],
  );

  const setSessionHidden = useCallback(
    (id: string, hidden: boolean) => {
      setSessions((current) => setChatGPTSessionHidden(current, id, hidden));
      if (hidden) retireChatGPTCaffy(id, "hidden");
    },
    [setSessions],
  );

  const setSessionWorker = useCallback(
    (id: string, worker: boolean) =>
      setSessions((current) =>
        current.map((session) =>
          session.id !== id
            ? session
            : worker
              ? {
                  ...session,
                  markedAsWorkerAt: Date.now(),
                  humanControlled: false,
                  autoCloseExempt: false,
                }
              : {
                  ...session,
                  markedAsWorkerAt: undefined,
                  humanControlled: true,
                  autoCloseExempt: true,
                },
        ),
      ),
    [setSessions],
  );

  const setSessionArchived = useCallback(
    (id: string, archive: NonNullable<BrowserSession["archive"]>) => {
      setSessions((current) => setChatGPTSessionArchived(current, id, archive));
      retireChatGPTCaffy(id, "hidden");
    },
    [setSessions],
  );

  return {
    sessions,
    prewarmedSessionId,
    setPrewarmedSessionId,
    createSession,
    registerBootstrapMarker,
    resolveBootstrapTitle,
    suggestBootstrapTitle,
    disqualifyManualEmptyCandidate,
    reorderSessions,
    renameSession,
    renameSessionFromPageTitle,
    removeSession,
    setSessionHidden,
    setSessionWorker,
    setSessionArchived,
    setSessionProject,
    setSessionParent,
    setSessionBinding,
    finalizeRollover,
    setSessionSnooze,
    setSessionVerification,
    quickSnoozeSession,
    resetQuickSnooze,
    setSessionBorderColor,
    toggleSessionReturnMarker,
    clearSessionReturnMarker,
    observeSessionReturnMarker,
    markHumanControlled,
    markDirectInteraction,
    setSessionCompletion,
    syncInferredMetadata,
    pruneExpiredHidden,
  };
}
