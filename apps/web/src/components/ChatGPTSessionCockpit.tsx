import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { useStore } from "zustand";
import { AlertTriangleIcon, ArrowUpIcon, HistoryIcon, SearchIcon, CopyIcon } from "lucide-react";

import {
  chatGPTBrowserThreadRef,
  chatGPTBrowserLastUrlKey,
  findExistingChatGPTConversation,
  useChatGPTBrowserSessions,
} from "../chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "../chatGPTConversationIdentity";
import { useChatGPTSmartLinks } from "../browser/chatGPTSmartLinks";
import { readChatGPTTranscript } from "../state/chatGPTTranscriptIndex";
import { useAtomCommand } from "../state/use-atom-command";
import { touchChatGPTGuest } from "../browser/chatGPTGuestHibernation";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import {
  isChatGPTDashboardSnapshot,
  projectChatGPTDashboardSession,
} from "../chatGPTDashboardData";
import { getChatGPTSessionPersistedStore } from "../chatGPTSessionPersistedStore";
import { hasUncertainChatGPTSend, runChatGPTSessionControl } from "../chatGPTSessionControl";
import { useThreadPreviewState } from "../previewStateStore";
import { readChatGPTRecoveryEvents, readChatGPTRecoveryState } from "../chatGPTRecoveryDiagnostics";
import { manuallyRetryRecovery, readRecoveryQueue } from "./sidebar/chatGPTRecoveryQueue";
import { Button } from "./ui/button";
import { getLocalStorageItem, useLocalStorage } from "../hooks/useLocalStorage";
import { ChatGPTSessionLiveTaskBrief } from "./ChatGPTSessionLiveTaskBrief";
import { ChatGPTSessionQuestionPanel } from "./ChatGPTSessionQuestionPanel";
import { answerChatGPTSessionQuestion, useChatGPTSessionQuestion } from "../chatGPTSessionQuestion";
import {
  ChatGPTSessionSearchPanel,
  type ChatGPTSessionSearchHit,
} from "./ChatGPTSessionSearchPanel";
import { queueChatGPTIndexedFind } from "../chatGPTIndexedFind";
import {
  cancelChatGPTSessionQueuedMessage,
  queueChatGPTSessionMessage,
  useChatGPTSessionQueue,
} from "../chatGPTSessionMessageQueue";

/** Clickable links in the read-only transcript use the same action as browser links. */
function LinkedTranscript({ text, onOpen }: { text: string; onOpen: (url: string) => void }) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {text.split(/(https?:\/\/[^\s<>\]\)]+)/g).map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <button
            key={index}
            type="button"
            className="text-info underline underline-offset-2"
            onClick={() => onOpen(part)}
          >
            {part}
          </button>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  );
}

type OfflineTranscript = {
  conversationId: string;
  lastObservedAt: string | null;
  firstTurnMissing: boolean;
  limited: boolean;
  messages: readonly {
    role: "assistant" | "user";
    turnIndex: number;
    ordinal: number;
    text: string;
    observedAt: string;
    possiblyTruncated: boolean;
  }[];
};
type TranscriptEntry = { role: "assistant" | "user"; text: string };
function parseReadResult(value: unknown): TranscriptEntry[] {
  if (!value || typeof value !== "object") return [];
  const body = value as { session?: { messages?: unknown } };
  if (!Array.isArray(body.session?.messages)) return [];
  return body.session.messages
    .filter(
      (message): message is { role: string; text: string } =>
        message !== null &&
        typeof message === "object" &&
        ["assistant", "user"].includes(message.role) &&
        typeof message.text === "string",
    )
    .map((message) => ({
      role: message.role as TranscriptEntry["role"],
      text: message.text.slice(0, 4500),
    }));
}

export function ChatGPTSessionCockpit({
  environmentId,
  sessionId,
  onShowBrowser,
}: {
  environmentId: EnvironmentId;
  sessionId: string;
  onShowBrowser: () => void;
}) {
  const navigate = useNavigate();
  const openSmartLink = useChatGPTSmartLinks(environmentId);
  const store = useMemo(() => getChatGPTSessionPersistedStore(environmentId), [environmentId]);
  const rawSnapshot = useStore(store, (state) => state.snapshots[sessionId]);
  const timeline = useStore(store, (state) => state.timeline[sessionId]);
  const { sessions, createSession, setSessionHidden, setSessionSnooze, setSessionCompletion } =
    useChatGPTBrowserSessions(environmentId);
  const childSnapshots = useStore(store, (state) => state.snapshots);
  const session = sessions.find((row) => row.id === sessionId);
  const workers = sessions.filter(
    (row) => (row.binding?.parentSessionId ?? row.parentSessionId) === sessionId && !row.hidden,
  );
  const binding = session?.binding;
  const snapshot = isChatGPTDashboardSnapshot(rawSnapshot) ? rawSnapshot : null;
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );
  const preview = useThreadPreviewState(threadRef);
  const [now, setNow] = useState(Date.now);
  // The cockpit is overlaid and unmounted on Browser toggle. Keep the user's
  // unsent text scoped to the exact desktop session, never in the page probe.
  const [draft, setDraft] = useLocalStorage(
    `t3code:chatgpt-browser:cockpit-draft:v1:${environmentId}:${sessionId}`,
    "",
    Schema.String,
  );
  const [mode, setMode] = useLocalStorage(
    `t3code:chatgpt-browser:composer-mode:v1:${environmentId}:${sessionId}`,
    "queue" as "queue" | "steer" | "capacity",
    Schema.Literals(["queue", "steer", "capacity"]),
  );
  const [maxActiveWorkers, setMaxActiveWorkers] = useLocalStorage(
    `t3code:chatgpt-browser:capacity-workers:v1:${environmentId}:${sessionId}`,
    4,
    Schema.Number,
  );
  const [teamOpen, setTeamOpen] = useLocalStorage(
    `t3code:chatgpt-browser:team-open:v1:${environmentId}:${sessionId}`,
    true,
    Schema.Boolean,
  );
  const [quickActions, setQuickActions] = useLocalStorage(
    `t3code:chatgpt-browser:quick-actions:v1:${environmentId}:${sessionId}`,
    [] as Array<{ label: string; text: string; mode: "queue" | "steer" }>,
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        text: Schema.String,
        mode: Schema.Literals(["queue", "steer"]),
      }),
    ),
  );
  const [editingActions, setEditingActions] = useState(false);
  const [actionLabel, setActionLabel] = useState("");
  const [actionText, setActionText] = useState("");
  const [actionMode, setActionMode] = useState<"queue" | "steer">("queue");
  const queuedMessages = useChatGPTSessionQueue(environmentId, sessionId);
  const userQuestion = useChatGPTSessionQuestion(environmentId, sessionId);
  const pendingMessages = queuedMessages.filter((row) => row.state !== "delivered");
  const [sending, setSending] = useState(false);
  const [reading, setReading] = useState(false);
  const readCachedTranscript = useAtomCommand(readChatGPTTranscript, { reportFailure: false });
  const [cached, setCached] = useState<OfflineTranscript | null>(null);
  const [cacheStatus, setCacheStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [history, setHistory] = useState<TranscriptEntry[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const openTranscriptLink = (url: string) => {
    void openSmartLink(url)
      .then((handled) => {
        if (!handled) return window.desktopBridge?.openExternal(url);
      })
      .catch((cause: unknown) => setMessage(`Could not open link: ${String(cause)}`));
  };
  const [searchOpen, setSearchOpen] = useState(false);
  const [previewMatch, setPreviewMatch] = useState<ChatGPTSessionSearchHit | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const followLatestRef = useRef(true);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const onSearchShortcut = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "f"
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onSearchShortcut, true);
    return () => window.removeEventListener("keydown", onSearchShortcut, true);
  }, []);
  useEffect(() => {
    if (!preview.activeTabId) return;
    // The browser surface is intentionally hidden under Session, but the user
    // is still viewing and controlling this guest: never idle-unload its draft.
    touchChatGPTGuest(
      previewRuntimeTabId(threadRef, preview.serverEpoch, preview.activeTabId),
      now,
    );
  }, [threadRef, preview.activeTabId, preview.serverEpoch, now]);
  useEffect(() => {
    setHistory([]);
    setMessage(null);
    setSearchOpen(false);
    setPreviewMatch(null);
    try {
      const saved = window.sessionStorage.getItem("t3code:chatgpt:session-match:v1");
      if (!saved) return;
      const data = JSON.parse(saved) as ChatGPTSessionSearchHit;
      if (data.sessionId === sessionId) {
        setPreviewMatch(data);
        window.sessionStorage.removeItem("t3code:chatgpt:session-match:v1");
      }
    } catch {
      /* Search preview is optional; never block session rendering. */
    }
  }, [sessionId]);

  const cachedConversationId =
    snapshot?.conversationId ??
    chatGPTConversationIdFromUrl(
      getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, sessionId), Schema.String),
    ) ??
    chatGPTConversationIdFromUrl(session?.archive?.conversationUrl ?? null);
  useEffect(() => {
    let disposed = false;
    setCached(null);
    if (!cachedConversationId) {
      setCacheStatus("unavailable");
      return;
    }
    setCacheStatus("loading");
    void readCachedTranscript({
      environmentId,
      input: {
        conversationId: cachedConversationId,
        limit: 200,
      },
    })
      .then((result) => {
        if (disposed) return;
        if (result._tag === "Success") {
          setCached(result.value);
          setCacheStatus("ready");
        } else {
          setCacheStatus("unavailable");
        }
      })
      .catch(() => {
        if (!disposed) setCacheStatus("unavailable");
      });
    return () => {
      disposed = true;
    };
  }, [environmentId, sessionId, cachedConversationId, readCachedTranscript]);
  const uncertain = hasUncertainChatGPTSend(environmentId, sessionId);
  const restartOutcome = useMemo(() => {
    try {
      const receipt = window.localStorage.getItem(
        `t3code:chatgpt-browser:restart-continuation:v1:${environmentId}:${sessionId}`,
      );
      if (!receipt) return null;
      const value = JSON.parse(receipt) as { state?: string; at?: number; fingerprint?: string };
      if (!snapshot || !value.fingerprint?.startsWith(`${snapshot.conversationId}:`)) return null;
      return value.state === "uncertain" ||
        value.state === "attempting" ||
        value.state === "confirmed"
        ? value
        : null;
    } catch {
      return null;
    }
  }, [environmentId, sessionId, snapshot?.conversationId, now]);
  const model = session
    ? projectChatGPTDashboardSession({
        session,
        snapshot,
        now,
        uncertainSend: uncertain,
        lastWorkingAt: timeline?.active ?? 0,
      }).model
    : null;
  // Keep new turns at the bottom, but respect manual scrolling into older turns.
  // Layout alignment below also anchors short conversations to the composer.
  useLayoutEffect(() => {
    const scroller = transcriptRef.current;
    if (scroller && followLatestRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [sessionId, snapshot?.conversationId, snapshot?.contentHash]);

  useLayoutEffect(() => {
    if (!previewMatch || !transcriptRef.current) return;
    followLatestRef.current = false;
    transcriptRef.current.scrollTop = 0;
  }, [previewMatch]);

  const ageSeconds = snapshot ? Math.max(0, Math.floor((now - snapshot.observedAt) / 1000)) : null;
  const live = ageSeconds !== null && ageSeconds <= 120;
  const nav = preview.snapshot?.navStatus;
  const navUrl = nav?._tag === "Success" ? nav.url : null;
  const wrongConversation =
    !!navUrl && !!snapshot && chatGPTConversationIdFromUrl(navUrl) !== snapshot.conversationId;
  // Queue accepts a message before a page observation exists; the mounted
  // runtime, not this view, waits for a verified idle recipient. Steer is the
  // explicit immediate path, using the existing guarded send implementation.
  const canQueue = !sending && draft.trim().length > 0;
  const canSteer = !!session && !sending && !uncertain && draft.trim().length > 0;
  const canSend =
    mode === "steer"
      ? canSteer
      : mode === "capacity"
        ? canQueue && !!window.desktopBridge?.chatGPTCapacityMessage
        : canQueue;
  const events = useMemo(
    () => readChatGPTRecoveryEvents(environmentId, sessionId, 12),
    [environmentId, sessionId, now],
  );
  const recovery = useMemo(
    () => readChatGPTRecoveryState(environmentId, sessionId),
    [environmentId, sessionId, now],
  );

  const chooseSearchResult = async (hit: ChatGPTSessionSearchHit) => {
    const owner =
      sessions.find((candidate) => candidate.id === hit.sessionId) ??
      (hit.url
        ? findExistingChatGPTConversation(sessions, hit.url, (id) =>
            getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, id), Schema.String),
          )
        : undefined);
    if (!owner) {
      const conversationId = chatGPTConversationIdFromUrl(hit.url);
      if (!conversationId)
        throw new Error("Indexed conversation has no verified canonical URL; no session opened.");
      const newSessionId = createSession(hit.title ?? "Saved conversation", {
        initialConversationUrl: `https://chatgpt.com/c/${conversationId}`,
        ...(hit.project ? { project: hit.project } : {}),
        explicitlyUserCreated: true,
      });
      setSearchOpen(false);
      if (hit.snippet)
        window.sessionStorage.setItem(
          "t3code:chatgpt:session-match:v1",
          JSON.stringify({ ...hit, sessionId: newSessionId }),
        );
      await navigate({
        to: "/browser/$browserSessionId",
        params: { browserSessionId: newSessionId },
      });
      return;
    }
    if (owner.hidden) setSessionHidden(owner.id, false);
    if ((owner.snoozedUntil ?? 0) > Date.now()) setSessionSnooze([owner.id], null);
    setSearchOpen(false);
    if (hit.snippet) {
      if (owner.id === sessionId) setPreviewMatch(hit);
      else
        window.sessionStorage.setItem(
          "t3code:chatgpt:session-match:v1",
          JSON.stringify({ ...hit, sessionId: owner.id }),
        );
    }
    if (owner.id !== sessionId)
      await navigate({ to: "/browser/$browserSessionId", params: { browserSessionId: owner.id } });
  };
  const prefill = (text: string) => {
    if (draft.trim()) {
      setMessage(
        "Your existing unsent draft was preserved. Clear it before using a suggested message.",
      );
      return;
    }
    setDraft(text);
  };
  const guardedReload = async () => {
    if (uncertain || draft.trim() || snapshot?.signals.draftPresent) {
      setMessage("A pending delivery or unsent draft must be resolved before reloading.");
      return;
    }
    setMessage(null);
    try {
      await runChatGPTSessionControl({
        environmentId,
        sessions,
        sessionId,
        action: "reload",
        force: false,
      });
      setMessage("Guarded reload requested. Waiting for the browser to confirm the page.");
    } catch (cause) {
      setMessage(`Reload unavailable: ${String(cause)}`);
    }
  };
  const retryRecovery = () => {
    const queue = readRecoveryQueue(environmentId);
    if (queue.failures[sessionId]) {
      manuallyRetryRecovery(environmentId, sessionId);
      setMessage("Recovery retry requested.");
    } else {
      setMessage(
        "No pending recovery episode. Use guarded reload or open Browser to inspect the page.",
      );
    }
  };
  const completeSession = () => {
    if (
      !snapshot ||
      !session ||
      snapshot.activity !== "idle" ||
      !live ||
      !snapshot.signals.composerPresent ||
      snapshot.signals.stopButton ||
      snapshot.signals.draftPresent ||
      !snapshot.lastAssistant?.text ||
      uncertain ||
      draft.trim() ||
      model?.attention !== "none"
    ) {
      setMessage("Mark complete requires a fresh idle response, no draft and no pending delivery.");
      return;
    }
    setSessionCompletion(sessionId, {
      declaredAt: new Date().toISOString(),
      observedTurns: snapshot.turnCount,
      observedUrl: snapshot.url,
    });
    setMessage("Session marked complete for the observed conversation.");
  };

  const refreshHistory = async () => {
    if (!session || reading) return;
    setReading(true);
    setMessage(null);
    try {
      const data = await runChatGPTSessionControl({
        environmentId,
        sessions,
        action: "read",
        sessionId,
        from: "end",
        count: 6,
        ...(snapshot ? { expectedConversationId: snapshot.conversationId } : {}),
      });
      const parsed = parseReadResult(data);
      setHistory(parsed);
      if (parsed.length === 0)
        setMessage("No readable earlier turns. Open Browser to inspect the conversation.");
    } catch (cause) {
      setMessage(`Unable to read the conversation: ${String(cause)}`);
    } finally {
      setReading(false);
    }
  };
  const submitQuestionAnswer = async (answer: string) => {
    if (!userQuestion || userQuestion.status !== "pending") return;
    const target = navUrl
      ? chatGPTConversationIdFromUrl(navUrl)
      : (snapshot?.conversationId ??
        chatGPTConversationIdFromUrl(
          getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, sessionId), Schema.String),
        ));
    // The existing durable queue preserves the original conversation guard
    // and UNKNOWN-send fence; answering never overwrites the user's draft.
    const queuedId = queueChatGPTSessionMessage(
      environmentId,
      sessionId,
      `Answer to your pending question: ${answer}`,
      target,
      userQuestion.id,
    );
    answerChatGPTSessionQuestion(environmentId, sessionId, userQuestion.id, answer, queuedId);
  };
  const sendAction = async (action: { label: string; text: string; mode: "queue" | "steer" }) => {
    if (sending || !action.text.trim()) return;
    const expectedConversationId = navUrl
      ? chatGPTConversationIdFromUrl(navUrl)
      : (snapshot?.conversationId ??
        chatGPTConversationIdFromUrl(
          getLocalStorageItem(chatGPTBrowserLastUrlKey(environmentId, sessionId), Schema.String),
        ));
    if (action.mode === "queue") {
      queueChatGPTSessionMessage(environmentId, sessionId, action.text, expectedConversationId);
      setMessage(`Queued "${action.label}" for this session.`);
      return;
    }
    if (!session || uncertain) {
      setMessage("Cannot steer an unavailable session or an unconfirmed delivery.");
      return;
    }
    setSending(true);
    try {
      const result = await runChatGPTSessionControl({
        environmentId,
        sessions,
        action: "send",
        sessionId,
        message: action.text.trim(),
        ...(expectedConversationId ? { expectedConversationId } : {}),
      });
      setMessage(
        result &&
          typeof result === "object" &&
          (result as { delivery?: string }).delivery === "user_turn_observed"
          ? `Delivered "${action.label}".`
          : "Delivery unconfirmed. Inspect Browser before retrying.",
      );
    } catch (cause) {
      setMessage(`Delivery failed or needs reconciliation: ${String(cause)}`);
    } finally {
      setSending(false);
    }
  };
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setMessage(null);
    try {
      if (mode !== "steer") {
        const target = navUrl
          ? chatGPTConversationIdFromUrl(navUrl)
          : (snapshot?.conversationId ??
            chatGPTConversationIdFromUrl(
              getLocalStorageItem(
                chatGPTBrowserLastUrlKey(environmentId, sessionId),
                Schema.String,
              ),
            ));
        queueChatGPTSessionMessage(
          environmentId,
          sessionId,
          draft,
          target,
          undefined,
          mode === "capacity" ? { condition: "wait_for_slot", maxActiveWorkers } : undefined,
        );
        setDraft("");
        setMessage(
          mode === "capacity"
            ? `Waiting for an idle session and fewer than ${maxActiveWorkers} active workers.`
            : "Queued. It will send when the exact session becomes idle and readable.",
        );
        return;
      }
      const expectedConversationId = navUrl
        ? chatGPTConversationIdFromUrl(navUrl)
        : (snapshot?.conversationId ?? null);
      const result = await runChatGPTSessionControl({
        environmentId,
        sessions,
        action: "send",
        sessionId,
        message: draft.trim(),
        ...(expectedConversationId ? { expectedConversationId } : {}),
      });
      const receipt =
        result && typeof result === "object"
          ? (result as { delivery?: string; messageSent?: boolean })
          : {};
      if (receipt.delivery === "user_turn_observed") {
        setDraft("");
        setMessage("Steer delivered. Message confirmed in the conversation.");
      } else {
        setMessage(
          "Message delivery is not confirmed. Open Browser and inspect before sending again.",
        );
      }
    } catch (cause) {
      setMessage(
        `Send failed or requires reconciliation: ${String(cause)}. Check Browser before retrying.`,
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      className="absolute inset-0 z-20 flex min-h-0 flex-col overflow-hidden bg-background"
      aria-label="ChatGPT session cockpit"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">
            {session?.title ?? "ChatGPT session"}
          </h2>
          <p className="text-xs text-muted-foreground">
            {session?.project ?? "ChatGPT"} ·{" "}
            {live
              ? "Recent observation"
              : ageSeconds === null
                ? "No snapshot yet"
                : `Last seen ${Math.floor(ageSeconds / 60)} min ago`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setSearchOpen((open) => !open)}>
            <SearchIcon className="size-4" /> Search
          </Button>
          <Button size="sm" variant="outline" onClick={onShowBrowser}>
            Open Browser
          </Button>
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2 text-xs text-muted-foreground">
        <span className="rounded-full border border-border bg-card px-2.5 py-1 font-medium text-foreground">
          {model?.statusLine ?? "Starting session"}
        </span>
        {snapshot && (
          <span className="rounded-full border border-border px-2 py-1">
            Turn {snapshot.turnCount}
          </span>
        )}
        {snapshot && (
          <span className="rounded-full border border-border px-2 py-1">
            {live ? "Live observation" : `Cached · ${Math.floor((ageSeconds ?? 0) / 60)}m old`}
          </span>
        )}
        <span>{preview.activeTabId ? "Browser tab present" : "Browser tab not attached"}</span>
      </div>
      {searchOpen && (
        <ChatGPTSessionSearchPanel
          environmentId={environmentId}
          sessions={sessions}
          onClose={() => setSearchOpen(false)}
          onChoose={chooseSearchResult}
        />
      )}
      {userQuestion && (
        <ChatGPTSessionQuestionPanel
          key={userQuestion.id}
          question={userQuestion}
          onAnswer={submitQuestionAnswer}
        />
      )}
      <ChatGPTSessionLiveTaskBrief
        environmentId={environmentId}
        sessionId={sessionId}
        taskId={binding?.taskRef?.id ?? null}
        onPrefill={prefill}
      />
      {restartOutcome && (
        <div
          role="status"
          className={`border-b px-5 py-2 text-xs ${
            restartOutcome.state === "confirmed"
              ? "border-emerald-600/30 bg-emerald-600/10"
              : "border-amber-600/30 bg-amber-600/10"
          }`}
        >
          {restartOutcome.state === "confirmed"
            ? "Automatic continuation after restart was confirmed in this conversation."
            : "Automatic continuation after restart may be unconfirmed. Inspect Browser and reconcile the send before repeating any message."}
        </div>
      )}
      {workers.length > 0 && (
        <details
          className="shrink-0 border-b border-border px-5 py-2"
          open={teamOpen}
          onToggle={(event) => setTeamOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-xs font-medium">
            Team · {workers.length} direct workers
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {workers.map((worker) => {
              const raw = childSnapshots[worker.id];
              const child = isChatGPTDashboardSnapshot(raw) ? raw : null;
              return (
                <div
                  key={worker.id}
                  className="min-w-44 flex-1 rounded-md border border-border/60 bg-background/70 p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold" title={worker.title}>
                      {worker.title}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        void navigate({
                          to: "/browser/$browserSessionId",
                          params: { browserSessionId: worker.id },
                        })
                      }
                    >
                      Open
                    </Button>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {child?.lastAssistant?.text ?? "No recent page observation"}
                  </p>
                  {child && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {child.activity} · turn {child.turnCount}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_18rem] lg:overflow-hidden">
        <div className="flex min-h-[400px] flex-col overflow-hidden lg:min-h-0">
          <div
            ref={transcriptRef}
            className="min-h-0 flex-1 overflow-y-auto p-5"
            onScroll={(event) => {
              const scroller = event.currentTarget;
              followLatestRef.current =
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
            }}
          >
            <div className="flex min-h-full flex-col justify-end gap-4">
              {(!live || !snapshot) && (
                <section
                  aria-label="Cached offline conversation"
                  className="space-y-2 rounded-lg border border-border bg-card/60 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold">
                      Offline conversation cache · read only
                    </h3>
                    <span className="text-2xs text-muted-foreground">
                      {cacheStatus === "loading"
                        ? "Reading local index…"
                        : cacheStatus === "unavailable"
                          ? "Index unavailable"
                          : cached?.lastObservedAt
                            ? `Observed ${new Date(cached.lastObservedAt).toLocaleString()}`
                            : "No indexed messages"}
                    </span>
                  </div>
                  {cached && cached.messages.length > 0 && (
                    <>
                      <p className="text-2xs text-muted-foreground">
                        {cached.messages.length} indexed messages
                        {cached.firstTurnMissing ? " · first turn not indexed" : ""}
                        {cached.limited ? " · older messages omitted (200-message limit)" : ""}
                        {cached.messages.some((entry) => entry.possiblyTruncated)
                          ? " · some messages truncated"
                          : ""}
                        {" ·"} Not guaranteed complete or current.
                      </p>
                      <div className="max-h-[65vh] space-y-2 overflow-y-auto">
                        {cached.messages.map((entry, index) => (
                          <div key={index} className="rounded bg-muted/40 p-2 text-xs">
                            <div className="mb-1 text-2xs font-semibold text-muted-foreground">
                              {entry.role === "user" ? "You" : "ChatGPT"} · turn {entry.turnIndex}
                            </div>
                            <LinkedTranscript text={entry.text} onOpen={openTranscriptLink} />
                            {entry.possiblyTruncated && (
                              <p className="mt-1 text-2xs text-muted-foreground">Partial message</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {cacheStatus === "ready" && !cached?.messages.length && (
                    <p className="text-xs text-muted-foreground">
                      No locally indexed conversation turns.
                    </p>
                  )}
                </section>
              )}
              {snapshot ? (
                <>
                  {previewMatch && (
                    <div className="rounded-lg border border-border bg-card/70 p-3" role="status">
                      <div className="flex items-center justify-between gap-2 text-xs font-semibold">
                        <span>
                          Indexed message match · turn {previewMatch.turnIndex} ·{" "}
                          {previewMatch.role === "user" ? "You" : "ChatGPT"}
                        </span>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              if (queueChatGPTIndexedFind(threadRef, previewMatch)) onShowBrowser();
                              else
                                setMessage(
                                  "This indexed excerpt has no exact highlighted search term; inspect Browser manually.",
                                );
                            }}
                          >
                            Find in Browser
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => setPreviewMatch(null)}>
                            Dismiss
                          </Button>
                        </div>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                        {previewMatch.snippet}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Search excerpt, not a fresh page observation. Open Browser to inspect the
                        full turn.
                      </p>
                    </div>
                  )}
                  <details
                    className="rounded-md border border-border/60 p-3"
                    onToggle={(e) => {
                      if (
                        (e.currentTarget as HTMLDetailsElement).open &&
                        history.length === 0 &&
                        !reading
                      )
                        void refreshHistory();
                    }}
                  >
                    <summary className="cursor-pointer text-sm font-medium">
                      Earlier turns (read only)
                    </summary>
                    <div className="mt-3 space-y-2">
                      {reading && (
                        <p className="text-xs text-muted-foreground">Reading conversation…</p>
                      )}
                      {history.map((entry, i) => (
                        <div key={i} className="rounded bg-muted/50 p-3">
                          <div className="mb-1 text-2xs font-medium uppercase">{entry.role}</div>
                          <p className="text-xs">
                            <LinkedTranscript text={entry.text} onOpen={openTranscriptLink} />
                          </p>
                        </div>
                      ))}
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={reading}
                        onClick={() => void refreshHistory()}
                      >
                        Refresh earlier turns
                      </Button>
                    </div>
                  </details>
                  <div className="ml-auto max-w-[92%] rounded-xl border border-border/60 bg-card/60 p-3">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      You · last observed
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {snapshot.lastUser?.text ?? "No user message in the saved excerpt."}
                      {snapshot.lastUser?.truncated ? " …" : ""}
                    </p>
                  </div>
                  <div className="border-l-2 border-border/80 py-1 pl-4 pr-2">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      ChatGPT · last observed
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm">
                      <LinkedTranscript
                        text={snapshot.lastAssistant?.text ?? "No assistant reply saved yet."}
                        onOpen={openTranscriptLink}
                      />
                      {snapshot.lastAssistant?.truncated ? " …" : ""}
                    </p>
                  </div>
                </>
              ) : (
                <div className="rounded-lg border border-border/60 bg-card/50 p-5 text-sm text-muted-foreground">
                  This session has no observed turns yet. Write your first message below and Queue
                  it; T3 will send when the exact ChatGPT page is ready. Use Browser for sign-in or
                  troubleshooting.
                </div>
              )}
            </div>
          </div>
          <form
            className="shrink-0 space-y-2 border-t border bg-background/80 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label htmlFor="t3-cockpit-compose" className="text-xs font-semibold">
              Message ·{" "}
              {mode === "queue"
                ? "send when idle"
                : mode === "capacity"
                  ? "wait for worker slot"
                  : "interrupt / steer now"}
            </label>
            <textarea
              id="t3-cockpit-compose"
              rows={3}
              className="w-full resize-y rounded-md border border-input bg-background p-3 text-sm"
              placeholder={
                uncertain ? "Resolve unconfirmed delivery before sending…" : "Message this session…"
              }
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="space-y-2 rounded-md border border-border/60 p-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">Custom buttons</span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setEditingActions(!editingActions)}
                >
                  {editingActions ? "Done" : "Edit"}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {quickActions.map((action, index) => (
                  <div key={index} className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      title={action.text}
                      disabled={sending || (action.mode === "steer" && (!session || uncertain))}
                      onClick={() => void sendAction(action)}
                    >
                      {action.label} · {action.mode === "queue" ? "Queue" : "Steer"}
                    </Button>
                    {editingActions && (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        aria-label={`Remove ${action.label}`}
                        onClick={() => setQuickActions(quickActions.filter((_, i) => i !== index))}
                      >
                        ×
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {editingActions && (
                <div className="space-y-2">
                  <input
                    aria-label="Button name"
                    placeholder="Button name"
                    maxLength={48}
                    className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                    value={actionLabel}
                    onChange={(event) => setActionLabel(event.target.value)}
                  />
                  <textarea
                    aria-label="Button message"
                    placeholder="Message to send"
                    rows={2}
                    className="w-full rounded border border-input bg-background p-2 text-sm"
                    value={actionText}
                    onChange={(event) => setActionText(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <select
                      aria-label="Button delivery mode"
                      value={actionMode}
                      className="rounded border border-input bg-background p-1 text-xs"
                      onChange={(event) => setActionMode(event.target.value as "queue" | "steer")}
                    >
                      <option value="queue">Queue when idle</option>
                      <option value="steer">Steer immediately</option>
                    </select>
                    <Button
                      type="button"
                      size="xs"
                      disabled={!actionLabel.trim() || !actionText.trim()}
                      onClick={() => {
                        setQuickActions([
                          ...quickActions,
                          { label: actionLabel.trim(), text: actionText.trim(), mode: actionMode },
                        ]);
                        setActionLabel("");
                        setActionText("");
                      }}
                    >
                      Add button
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  "Continue.",
                  "Report your progress and current blockers.",
                  "Summarize the work completed so far.",
                ] as const
              ).map((text) => (
                <Button
                  key={text}
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => prefill(text)}
                >
                  {text === "Continue."
                    ? "Continue"
                    : text.startsWith("Report")
                      ? "Report progress"
                      : "Summarize"}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <div
                  className="inline-flex rounded-md border border-border p-0.5"
                  role="group"
                  aria-label="Message delivery mode"
                >
                  <Button
                    type="button"
                    size="xs"
                    variant={mode === "queue" ? "secondary" : "ghost"}
                    aria-pressed={mode === "queue"}
                    onClick={() => setMode("queue")}
                  >
                    Queue
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={mode === "capacity" ? "secondary" : "ghost"}
                    aria-pressed={mode === "capacity"}
                    onClick={() => setMode("capacity")}
                    disabled={!window.desktopBridge?.chatGPTCapacityMessage}
                  >
                    Wait for slot
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={mode === "steer" ? "secondary" : "ghost"}
                    aria-pressed={mode === "steer"}
                    onClick={() => setMode("steer")}
                  >
                    Steer now
                  </Button>
                </div>
                <span>
                  {mode === "queue"
                    ? "Waits for idle"
                    : mode === "capacity"
                      ? "Idle + capacity available"
                      : "Immediate · interrupts current reply"}
                </span>
              </div>
              <Button type="submit" size="sm" disabled={!canSend}>
                <ArrowUpIcon aria-hidden className="size-3.5" />{" "}
                {sending
                  ? "Sending…"
                  : mode === "queue"
                    ? "Queue"
                    : mode === "capacity"
                      ? "Wait for slot"
                      : "Steer"}
              </Button>
            </div>
            {mode === "capacity" && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Max working agents
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={maxActiveWorkers}
                  className="w-16 rounded border border-input bg-background px-1 py-0.5"
                  onChange={(event) => {
                    const number = Number(event.target.value);
                    if (Number.isSafeInteger(number) && number >= 1 && number <= 100)
                      setMaxActiveWorkers(number);
                  }}
                />
                <span>Global OpenRig capacity, shared with TaskBoard.</span>
              </label>
            )}
            {pendingMessages.length > 0 && (
              <div
                role="status"
                className="space-y-1 rounded-lg border border-border/60 bg-background/60 p-2 text-xs text-muted-foreground"
              >
                <div className="font-semibold text-foreground">
                  Outbox · {pendingMessages.length} pending
                </div>
                {pendingMessages.slice(0, 4).map((row) => (
                  <div key={row.id} className="flex items-center gap-2">
                    <span className="shrink-0 capitalize">{row.state.replace("_", " ")}</span>
                    <span className="min-w-0 flex-1 truncate" title={row.detail ?? row.text}>
                      {row.text}
                    </span>
                    {(row.state === "queued" || row.state === "needs_attention") && (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          cancelChatGPTSessionQueuedMessage(environmentId, sessionId, row.id)
                        }
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                ))}
                {pendingMessages.some(
                  (row) => row.state === "unknown" || row.state === "needs_attention",
                ) && (
                  <span className="text-amber-500">
                    Delivery needs review; open Browser. No automatic retry.
                  </span>
                )}
              </div>
            )}
            {message && (
              <p
                role="status"
                className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400"
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                {message}
              </p>
            )}
          </form>
        </div>
        <aside className="flex min-h-fit flex-col gap-3 overflow-y-auto border-t border-border bg-card/20 p-3 lg:min-h-0 lg:border-l lg:border-t-0">
          <div className="order-4 rounded-lg border border-border/60 bg-background/60 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Omniwork binding
            </h3>
            {binding ? (
              <dl className="mt-2 space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Role</dt>
                  <dd className="font-medium capitalize">{binding.role}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Seat</dt>
                  <dd className="max-w-40 truncate font-mono" title={binding.seatId ?? ""}>
                    {binding.seatId ?? "Unassigned"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Task</dt>
                  <dd className="font-mono">
                    {binding.taskRef
                      ? `${binding.taskRef.board} · ${binding.taskRef.id}`
                      : "Unassigned"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Parent</dt>
                  <dd className="max-w-40 truncate font-mono" title={binding.parentSessionId ?? ""}>
                    {binding.parentSessionId ?? "Top-level"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                No confirmed Omniwork binding. Displayed titles and hierarchy do not prove a seat.
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              {workers.length} direct workers · Human Inbox count requires a linked inbox feed
            </p>
          </div>
          <div className="order-1 rounded-lg border border-border/60 bg-background/60 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Needs you
            </h3>
            <p className="mt-2 text-sm">
              {model?.attention === "none"
                ? "No outstanding action"
                : model?.attention === "unconfirmed_send"
                  ? "Delivery needs reconciliation"
                  : model?.attention === "question"
                    ? "ChatGPT is asking a question"
                    : model?.statusLine}
            </p>
          </div>
          <div className="order-2 rounded-lg border border-border/60 bg-background/60 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Actions
            </h3>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="xs" variant="outline" onClick={onShowBrowser}>
                Browser
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!session || reading}
                onClick={() => void refreshHistory()}
              >
                Read turns
              </Button>
              <Button size="xs" variant="outline" onClick={() => setSearchOpen(true)}>
                Search messages
              </Button>
              <Button size="xs" variant="outline" onClick={() => void guardedReload()}>
                Guarded reload
              </Button>
              <Button size="xs" variant="outline" onClick={retryRecovery}>
                Retry recovery
              </Button>
              {snapshot?.url && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(snapshot.url)
                      .then(() => setMessage("Conversation URL copied."))
                      .catch(() => setMessage("Could not copy the conversation URL."))
                  }
                >
                  <CopyIcon className="size-3" /> Copy URL
                </Button>
              )}
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  if (session?.snoozedUntil && session.snoozedUntil > Date.now()) {
                    setSessionSnooze([sessionId], null);
                    setMessage("Session unsnoozed.");
                  } else if (
                    model?.activity === "working" ||
                    uncertain ||
                    draft.trim() ||
                    snapshot?.signals.draftPresent
                  ) {
                    setMessage(
                      "Snoozing is unavailable while working, or while a draft or delivery is pending.",
                    );
                  } else {
                    setSessionSnooze([sessionId], Date.now() + 60 * 60_000);
                    setMessage("Snoozed for one hour.");
                  }
                }}
              >
                {session?.snoozedUntil && session.snoozedUntil > Date.now()
                  ? "Unsnooze"
                  : "Snooze 1h"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!snapshot || !live || model?.activity !== "idle"}
                onClick={completeSession}
              >
                Mark complete
              </Button>
            </div>
          </div>
          <div className="order-3 rounded-lg border border-border/60 bg-background/60 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recovery
            </h3>
            <p className="mt-2 text-xs">
              Attempts: {recovery.retryCount} · {recovery.orangeStage || "No active stage"}
            </p>
            <p className="text-xs text-muted-foreground">
              The recovery coordinator retains all mutation guards.
            </p>
          </div>
          <div className="order-5 rounded-lg border border-border/60 bg-background/60 p-3">
            <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <HistoryIcon className="size-3.5" /> Timeline
            </h3>
            {events.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No recovery events</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {events
                  .slice(-8)
                  .reverse()
                  .map((event, i) => (
                    <li className="text-xs" key={i}>
                      <span className="font-medium">{event.event}</span>
                      <div className="text-muted-foreground">
                        {new Date(event.at).toLocaleString()}
                      </div>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
