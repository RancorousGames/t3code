import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { readChatGPTBrowserSessions, useChatGPTBrowserSessions } from "../chatGPTBrowserSessions";
import {
  acknowledgeChatGPTSessionAttention,
  rearmPersistentSessionAttention,
} from "../chatGPTPersistentAttention";
import { markChatGPTAttentionVisited } from "../chatGPTAttentionWorkCycle";
import { readChatGPTSessionTimeline } from "../chatGPTSessionTimestamps";
import { readChatGPTProviderActivity } from "../chatGPTProviderActivity";
import { isCaffyIdleContinuationActive } from "../chatGPTCaffyAttentionPolicy";
import { readVerifiedT3CaffyOverview } from "../hooks/useT3CaffyOverview";
import {
  requestAgentAttention,
  cancelManualAgentAttention,
  priorityChatGPTAttentionTarget,
  loadAgentAttention,
  nextRecentAgentAttentionSessionId,
} from "../chatGPTAgentAttention";
import {
  acknowledgeNativeThreadAttention,
  isKnownNativeThread,
  nativeAttentionCandidates,
  nativeAttentionKey,
  nativeThreadTitle,
  parseNativeAttentionKey,
  readNativeThreadActivity,
  rearmNativeThreadAttention,
  skipNextNativeVisitAcknowledgement,
  toggleNativeThreadAttention,
} from "../nativeThreadAttention";
import { isTerminalFocused } from "../lib/terminalFocus";
import { toastManager } from "./ui/toast";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import { randomUUID } from "../lib/utils";
import { registerCommands, registerMenuAction } from "../shortcuts/dispatcher";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerKeybindingsAtom } from "../state/server";

/** Plain Ctrl+<key>, outside IME composition, the palette and keybinding capture fields. */
function isPlainCtrlKey(event: KeyboardEvent, key: string): boolean {
  return (
    event.key.toLowerCase() === key &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.isComposing &&
    !isCommandPaletteOpen() &&
    !(event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
  );
}

/** Handles both T3 keydowns and shortcuts forwarded from focused ChatGPT guests.
 * Ctrl+D (persistent attention) and Ctrl+S (open next attention) cover ChatGPT
 * sessions and native T3 threads alike. */
export function ChatGPTNewSessionShortcut() {
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const environmentId = usePrimaryEnvironmentId();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const lastRecentAttentionTarget = useRef<string | null>(null);
  const { createSession, toggleSessionReturnMarker, setSessionHidden, setSessionWorker } =
    useChatGPTBrowserSessions(environmentId);

  const createNewSession = useEffectEvent(() => {
    if (!isElectron || !environmentId) return;
    void navigate({
      to: "/browser/$browserSessionId",
      params: { browserSessionId: createSession(undefined, { explicitlyUserCreated: true }) },
    });
  });

  /** The open native thread's attention key, if a native thread route is open. */
  const openNativeKey = () => {
    const params = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: string;
      threadId?: string;
    };
    return params.environmentId && params.threadId
      ? nativeAttentionKey(params.environmentId, params.threadId)
      : null;
  };

  /** Ctrl+D target exists: the open ChatGPT session or native thread. */
  const canToggleReturnMarker = () =>
    /^\/browser\/[^/]+\/?$/.test(pathname) || openNativeKey() !== null;

  const toggleNativeReturnMarker = (key: string) => {
    const title = nativeThreadTitle(key) ?? "Thread";
    const enabled = toggleNativeThreadAttention(key);
    if (enabled) requestAgentAttention(randomUUID(), key, title, "manual");
    else cancelManualAgentAttention([key]);
    toastManager.add(
      enabled
        ? {
            type: "success",
            title: "Persistent attention enabled",
            description:
              readNativeThreadActivity(key) === "working"
                ? `${title}: yellow border when this response finishes`
                : `${title}: yellow border after the next response finishes`,
          }
        : { type: "success", title: "Persistent attention disabled", description: title },
    );
  };

  /** Navigate to a native thread whose attention was already acknowledged. */
  const openNativeThread = (key: string) => {
    const ref = parseNativeAttentionKey(key);
    if (!ref) return;
    skipNextNativeVisitAcknowledgement(key);
    void navigate({ to: "/$environmentId/$threadId", params: ref });
  };

  const toggleSelectedReturnMarker = useEffectEvent(() => {
    if (!isElectron || !environmentId || isCommandPaletteOpen()) return;
    const nativeKey = openNativeKey();
    if (nativeKey) {
      toggleNativeReturnMarker(nativeKey);
      return;
    }
    const sessionId = pathname.match(/^\/browser\/([^/]+)\/?$/)?.[1];
    if (!sessionId) return;
    const session = readChatGPTBrowserSessions(environmentId).find((item) => item.id === sessionId);
    if (!session) {
      toastManager.add({ type: "error", title: "Return marker: session not found" });
      return;
    }

    const observed = readChatGPTProviderActivity(environmentId, sessionId);
    const activity = observed === "working" || observed === "idle" ? observed : "unknown";
    toggleSessionReturnMarker(sessionId, activity);
    // Explicit persistent attention means the user has taken ownership of this chat.
    // Reuse the sidebar's Mark as personal action; disabling attention keeps that role.
    if (!session.returnMarker) setSessionWorker(sessionId, false);
    const ids = [
      session.id,
      ...(session.bootstrapIdentity?.publicId ? [session.bootstrapIdentity.publicId] : []),
    ];
    if (session.returnMarker) cancelManualAgentAttention(ids);
    else
      requestAgentAttention(
        randomUUID(),
        session.bootstrapIdentity?.publicId ?? session.id,
        session.title,
        "manual",
      );
    toastManager.add(
      session.returnMarker
        ? { type: "success", title: "Persistent attention disabled", description: session.title }
        : {
            type: "success",
            title: "Persistent attention enabled",
            description:
              activity === "working"
                ? `${session.title}: yellow border when this response finishes`
                : `${session.title}: yellow border after the next response finishes`,
          },
    );
  });

  const openLastAttentionSession = useEffectEvent(() => {
    if (!isElectron || !environmentId || isCommandPaletteOpen()) return;
    const sessions = readChatGPTBrowserSessions(environmentId);
    const now = Date.now();
    // Ctrl+S is navigation, never an implicit unsnooze action. Exclude
    // sleeping sessions from active alerts AND historical fallback.
    const awake = sessions.filter((entry) => (entry.snoozedUntil ?? 0) <= now);
    const availableIds = new Set(
      awake.flatMap((entry) => [
        entry.id,
        ...(entry.bootstrapIdentity?.publicId ? [entry.bootstrapIdentity.publicId] : []),
      ]),
    );
    const requests = loadAgentAttention();
    // Persistent yellow markers are authoritative even if their one-shot
    // notification is missing. Non-verification attention takes precedence
    // over Verification and historical receipts.
    const caffy = readVerifiedT3CaffyOverview();
    const target = priorityChatGPTAttentionTarget(
      [
        ...awake.map((entry) => ({
          id: entry.id,
          bootstrapIdentity: entry.bootstrapIdentity,
          verificationPending: entry.verificationPending,
          returnMarker: entry.returnMarker,
          hidden: entry.hidden,
          snoozedUntil: entry.snoozedUntil,
          working:
            readChatGPTProviderActivity(environmentId, entry.id) === "working" ||
            isCaffyIdleContinuationActive(caffy, entry, now),
          lastActiveAt: readChatGPTSessionTimeline(environmentId, entry).lastActiveAt,
        })),
        ...nativeAttentionCandidates(requests, now),
      ],
      requests,
    );
    if (target && parseNativeAttentionKey(target.sessionId)) {
      if (target.requestId) {
        if (!acknowledgeNativeThreadAttention(target.sessionId, target.requestId)) return;
      } else {
        rearmNativeThreadAttention(target.sessionId);
      }
      lastRecentAttentionTarget.current = null;
      openNativeThread(target.sessionId);
      return;
    }
    if (target) {
      const session = sessions.find(
        (entry) =>
          entry.id === target.sessionId || entry.bootstrapIdentity?.publicId === target.sessionId,
      );
      if (!session) return;
      const activity = readChatGPTProviderActivity(environmentId, session.id);
      if (target.requestId) {
        // Opening a notification consumes only that entry, preserving the stack.
        if (!acknowledgeChatGPTSessionAttention(environmentId, session, activity, target.requestId))
          return;
      } else {
        // A yellow marker can outlive its notification record. Acknowledge the
        // marker without clearing independent waiting agent requests.
        rearmPersistentSessionAttention(environmentId, session, activity);
        markChatGPTAttentionVisited(environmentId, session.id, activity);
      }
      lastRecentAttentionTarget.current = null;
      setSessionHidden(session.id, false);
      void navigate({ to: "/browser/$browserSessionId", params: { browserSessionId: session.id } });
      return;
    }
    // Only once NO marked-ready or pending sessions remain does Ctrl+S cycle
    // recent resolved attention receipts.
    const selectedId = pathname.match(/^\/browser\/([^/]+)\/?$/)?.[1];
    const selected = sessions.find((entry) => entry.id === selectedId);
    const selectedNative = openNativeKey();
    const nativeAwake = nativeAttentionCandidates(requests, now);
    for (const entry of nativeAwake) availableIds.add(entry.id);
    const workingIds = new Set([
      ...sessions.flatMap((entry) =>
        readChatGPTProviderActivity(environmentId, entry.id) === "working"
          ? [
              entry.id,
              ...(entry.bootstrapIdentity?.publicId ? [entry.bootstrapIdentity.publicId] : []),
            ]
          : [],
      ),
      ...nativeAwake.filter((entry) => entry.working).map((entry) => entry.id),
    ]);
    const verificationIds = new Set(
      sessions.flatMap((entry) =>
        entry.verificationPending
          ? [
              entry.id,
              ...(entry.bootstrapIdentity?.publicId ? [entry.bootstrapIdentity.publicId] : []),
            ]
          : [],
      ),
    );
    const nextId = nextRecentAgentAttentionSessionId(
      requests,
      availableIds,
      selected
        ? [
            selected.id,
            ...(selected.bootstrapIdentity?.publicId ? [selected.bootstrapIdentity.publicId] : []),
          ]
        : selectedNative
          ? [selectedNative]
          : [],
      workingIds,
      lastRecentAttentionTarget.current ?? undefined,
      verificationIds,
    );
    if (nextId && isKnownNativeThread(nextId)) {
      lastRecentAttentionTarget.current = nextId;
      openNativeThread(nextId);
      return;
    }
    const session = sessions.find(
      (entry) => entry.id === nextId || entry.bootstrapIdentity?.publicId === nextId,
    );
    if (!session) {
      lastRecentAttentionTarget.current = null;
      toastManager.add({ type: "info", title: "No recent attention sessions" });
      return;
    }
    lastRecentAttentionTarget.current = nextId ?? null;
    setSessionHidden(session.id, false);
    void navigate({ to: "/browser/$browserSessionId", params: { browserSessionId: session.id } });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the desktop shortcut and guest menu action while the app shell is mounted
  useEffect(() => {
    if (!isElectron || !environmentId) return;

    const unregisterKeydown = registerCommands(
      {
        "chatgpt.openLastAttention": (event) => {
          if (
            event.repeat ||
            event.isComposing ||
            isCommandPaletteOpen() ||
            (event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
          )
            return false;
          event.preventDefault();
          event.stopPropagation();
          openLastAttentionSession();
          return true;
        },
        "chatgpt.returnMarker": (event) => {
          if (
            !canToggleReturnMarker() ||
            !environmentId ||
            event.repeat ||
            event.isComposing ||
            isCommandPaletteOpen() ||
            (event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
          )
            return false;
          event.preventDefault();
          event.stopPropagation();
          toggleSelectedReturnMarker();
          return true;
        },
        "chatgpt.newSession": (event) => {
          if (
            event.repeat ||
            event.isComposing ||
            isCommandPaletteOpen() ||
            (event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
          )
            return false;
          event.preventDefault();
          event.stopPropagation();
          createNewSession();
          return true;
        },
      },
      {
        capture: true,
        // Ctrl+S opens the visible alert, or cycles recent resolved alerts
        // when there is no pending attention. Handle it before Mod+S conflicts.
        onKeyDown: (event) => {
          if (isPlainCtrlKey(event, "s")) {
            event.preventDefault();
            event.stopPropagation();
            openLastAttentionSession();
            return true;
          }
          // Ctrl+D toggles persistent attention on the open ChatGPT session or
          // native thread. Handled here, ahead of Mod+D diff.toggle, so binding
          // order in keybindings.json cannot shadow it.
          if (isPlainCtrlKey(event, "d") && !isTerminalFocused() && canToggleReturnMarker()) {
            event.preventDefault();
            event.stopPropagation();
            toggleSelectedReturnMarker();
            return true;
          }
          return false;
        },
        keybindings: () => keybindings,
        context: () => ({
          chatgptBrowserRoute: pathname === "/browser" || pathname.startsWith("/browser/"),
        }),
      },
    );
    const unregisterMenuAction = registerMenuAction("chatgpt.newSession", () => {
      if (!isCommandPaletteOpen()) createNewSession();
    });
    const unregisterReturnMarkerAction = registerMenuAction("chatgpt.return-marker", () => {
      toggleSelectedReturnMarker();
    });
    const unregisterOpenLastAttentionAction = registerMenuAction(
      "chatgpt.open-last-attention",
      () => {
        openLastAttentionSession();
      },
    );
    return () => {
      unregisterKeydown();
      unregisterMenuAction();
      unregisterReturnMarkerAction();
      unregisterOpenLastAttentionAction();
    };
  }, [environmentId, keybindings, pathname]);

  return null;
}
