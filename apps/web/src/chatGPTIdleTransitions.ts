import type { ChatGPTPageSnapshot } from "./chatGPTPageSnapshotInspection";

export const CHATGPT_IDLE_TRANSITION_EVENT = "t3:chatgpt-session-became-idle";
const PREFIX = "t3code:chatgpt-idle-transition:v1:";
const IDLE_CONFIRM_MS = 750;
// User-only idle is ambiguous for a moment after Send. A settled composer and
// unchanged turn across multiple independent probes make it safe to resume.
const USER_ONLY_IDLE_CONFIRM_MS = 3_000;

export interface ChatGPTIdleTransition {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  /** The boundAt receipt is the available binding version; the conversation is pinned separately. */
  readonly bindingRevision: string | null;
  readonly sequence: number;
  readonly eventId: string;
  readonly observedAt: number;
  readonly turnCount: number;
  /** A trusted Stop click ends a user-stopped turn, not an assistant completion. */
  readonly kind?: "completed" | "stopped" | "quiescent";
}

interface IdleJournal {
  readonly version: 1;
  readonly conversationId: string;
  readonly bindingRevision: string | null;
  readonly sequence: number;
  readonly workingTurn: number | null;
  readonly candidate: {
    readonly turn: number;
    readonly hash: string;
    readonly kind?: "completed" | "stopped" | "quiescent";
    readonly firstSeenAt: number;
  } | null;
  readonly lastEvent: ChatGPTIdleTransition | null;
}

const key = (environmentId: string, sessionId: string) => `${PREFIX}${environmentId}:${sessionId}`;

function readJournal(storage: Pick<Storage, "getItem">, name: string): IdleJournal | null {
  try {
    const raw = storage.getItem(name);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const data = value as Partial<IdleJournal>;
    return data.version === 1 &&
      typeof data.conversationId === "string" &&
      Number.isSafeInteger(data.sequence) &&
      (data.sequence ?? -1) >= 0
      ? (data as IdleJournal)
      : null;
  } catch {
    return null;
  }
}

export function readChatGPTIdleTransition(
  environmentId: string,
  sessionId: string,
  storage: Pick<Storage, "getItem"> = window.localStorage,
): ChatGPTIdleTransition | null {
  return readJournal(storage, key(environmentId, sessionId))?.lastEvent ?? null;
}

/** Pure transition reducer: a Stop disappearance is only a candidate, not a completed reply.
 * One subsequent, independently observed unchanged idle snapshot confirms completion.
 * No transcript, draft text, session title, or browser secret is persisted. */
export function advanceChatGPTIdleTransition(
  previous: IdleJournal | null,
  input: {
    environmentId: string;
    sessionId: string;
    bindingRevision: string | null;
    snapshot: ChatGPTPageSnapshot;
  },
): {
  journal: IdleJournal;
  event: ChatGPTIdleTransition | null;
  confirmAgain: boolean;
  changed: boolean;
} {
  const { environmentId, sessionId, bindingRevision, snapshot } = input;
  const sameBinding =
    previous?.conversationId === snapshot.conversationId &&
    previous.bindingRevision === bindingRevision;
  const current: IdleJournal = sameBinding
    ? previous!
    : {
        version: 1,
        conversationId: snapshot.conversationId,
        bindingRevision,
        sequence: previous?.sequence ?? 0,
        workingTurn: null,
        candidate: null,
        lastEvent: null,
      };
  const update = (fields: Partial<IdleJournal>) => ({
    journal: { ...current, ...fields },
    event: null,
    confirmAgain: false,
    changed: true,
  });
  if (snapshot.activity === "working" && snapshot.signals.stopButton && snapshot.turnCount > 0) {
    if (current.workingTurn === snapshot.turnCount && !current.candidate)
      return { journal: current, event: null, confirmAgain: false, changed: !sameBinding };
    return update({ workingTurn: snapshot.turnCount, candidate: null });
  }
  if (
    snapshot.activity === "interrupted" ||
    snapshot.activity === "failed" ||
    snapshot.signals.interruptedBanner ||
    snapshot.signals.loadError ||
    snapshot.signals.signInOrCaptcha ||
    snapshot.signals.conversationFull
  ) {
    if (!current.workingTurn && !current.candidate)
      return { journal: current, event: null, confirmAgain: false, changed: !sameBinding };
    return update({ workingTurn: null, candidate: null });
  }
  const safeIdle =
    snapshot.activity === "idle" &&
    !snapshot.signals.stopButton &&
    snapshot.signals.composerPresent &&
    !snapshot.signals.draftPresent &&
    !snapshot.signals.interruptedBanner &&
    !snapshot.signals.loadError &&
    !snapshot.signals.signInOrCaptcha &&
    !snapshot.signals.conversationFull &&
    snapshot.turnCount > 0;
  const explicitlyStopped =
    safeIdle &&
    snapshot.signals.explicitStopRequested === true &&
    (snapshot.lastTurnRole === "assistant" || snapshot.lastTurnRole === "user");
  const completed =
    safeIdle &&
    !explicitlyStopped &&
    snapshot.lastTurnRole === "assistant" &&
    !!snapshot.lastAssistant?.text.trim();
  // Explicitly authorized Caffy workers can be stopped after their initial
  // instruction, leaving only a user turn. This is idle, not "working".
  // Require a much longer unchanged snapshot than ordinary completion.
  const quiescent =
    safeIdle &&
    !explicitlyStopped &&
    !completed &&
    snapshot.lastTurnRole === "user" &&
    !!snapshot.lastUser?.text.trim();
  const kind = explicitlyStopped ? "stopped" : completed ? "completed" : "quiescent";
  if (
    (!completed && !explicitlyStopped && !quiescent) ||
    ((completed || explicitlyStopped) && current.workingTurn !== snapshot.turnCount)
  )
    return { journal: current, event: null, confirmAgain: false, changed: !sameBinding };
  // Never re-emit the same initial user-only idle when the observer remounts.
  // A new generation/turn or a different kind of transition remains eligible.
  if (
    quiescent &&
    current.lastEvent?.kind === "quiescent" &&
    current.lastEvent.turnCount === snapshot.turnCount
  )
    return { journal: current, event: null, confirmAgain: false, changed: !sameBinding };
  if (
    !current.candidate ||
    current.candidate.turn !== snapshot.turnCount ||
    current.candidate.hash !== snapshot.contentHash ||
    current.candidate.kind !== kind
  ) {
    return {
      ...update({
        candidate: {
          turn: snapshot.turnCount,
          hash: snapshot.contentHash,
          kind,
          firstSeenAt: snapshot.observedAt,
        },
      }),
      confirmAgain: true,
    };
  }
  if (
    snapshot.observedAt - current.candidate.firstSeenAt <
    (quiescent ? USER_ONLY_IDLE_CONFIRM_MS : IDLE_CONFIRM_MS)
  )
    return { journal: current, event: null, confirmAgain: true, changed: !sameBinding };
  const sequence = current.sequence + 1;
  const event: ChatGPTIdleTransition = {
    environmentId,
    sessionId,
    conversationId: snapshot.conversationId,
    bindingRevision,
    sequence,
    eventId: `${sessionId}:${snapshot.conversationId}:${sequence}`,
    observedAt: snapshot.observedAt,
    turnCount: snapshot.turnCount,
    kind,
  };
  return {
    journal: { ...current, sequence, workingTurn: null, candidate: null, lastEvent: event },
    event,
    confirmAgain: false,
    changed: true,
  };
}

/** Only the already-mounted, URL-verified page observer calls this.
 * Persist the monotonic sequence BEFORE notifying in-process/cross-window listeners. */
export function observeChatGPTIdleSnapshot(
  environmentId: string,
  sessionId: string,
  bindingRevision: string | null,
  snapshot: ChatGPTPageSnapshot,
  storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): { confirmAgain: boolean; event: ChatGPTIdleTransition | null } {
  let url: URL;
  try {
    url = new URL(snapshot.url);
  } catch {
    return { confirmAgain: false, event: null };
  }
  const conversationMatch = url.pathname.match(
    /^(?:\/g\/[^/]+)?\/c\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i,
  );
  if (
    !environmentId ||
    !sessionId ||
    !snapshot.conversationId ||
    url.protocol !== "https:" ||
    !["chatgpt.com", "www.chatgpt.com", "chat.openai.com"].includes(url.hostname) ||
    conversationMatch?.[1]?.toLowerCase() !== snapshot.conversationId.toLowerCase() ||
    !Number.isSafeInteger(snapshot.turnCount) ||
    snapshot.turnCount < 1
  )
    return { confirmAgain: false, event: null };
  const name = key(environmentId, sessionId);
  const before = readJournal(storage, name);
  const next = advanceChatGPTIdleTransition(before, {
    environmentId,
    sessionId,
    bindingRevision,
    snapshot,
  });
  if (next.changed) {
    try {
      storage.setItem(name, JSON.stringify(next.journal));
    } catch {
      // Missing persistence must not generate an unrepeatable wake notification.
      return { confirmAgain: false, event: null };
    }
  }
  if (next.event && typeof window !== "undefined")
    window.dispatchEvent(new CustomEvent(CHATGPT_IDLE_TRANSITION_EVENT, { detail: next.event }));
  return { confirmAgain: next.confirmAgain, event: next.event };
}

/** Consumers can subscribe without the sidebar being foregrounded. The same
 * event's last receipt remains queryable after renderer restart. */
export function subscribeChatGPTIdleTransitions(
  listener: (event: ChatGPTIdleTransition) => void,
): () => void {
  const onLocal = (event: Event) => {
    const detail = (event as CustomEvent<ChatGPTIdleTransition>).detail;
    if (detail?.eventId) listener(detail);
  };
  const onStorage = (event: StorageEvent) => {
    if (!event.key?.startsWith(PREFIX) || !event.newValue) return;
    try {
      const value = JSON.parse(event.newValue) as IdleJournal;
      const before = event.oldValue ? (JSON.parse(event.oldValue) as IdleJournal) : null;
      // A new working/candidate journal write must not replay the last idle event.
      if (
        value.version === 1 &&
        value.lastEvent?.eventId &&
        value.lastEvent.eventId !== before?.lastEvent?.eventId
      )
        listener(value.lastEvent);
    } catch {
      // A partially written or unrelated key never produces an event.
    }
  };
  window.addEventListener(CHATGPT_IDLE_TRANSITION_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHATGPT_IDLE_TRANSITION_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}
