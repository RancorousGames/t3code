import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { readChatGPTBrowserSessions, useChatGPTBrowserSessions } from "../chatGPTBrowserSessions";
import { acknowledgeChatGPTSessionAttention, rearmPersistentSessionAttention } from "../chatGPTPersistentAttention";
import { markChatGPTAttentionVisited } from "../chatGPTAttentionWorkCycle";
import { readChatGPTSessionTimeline } from "../chatGPTSessionTimestamps";
import { readChatGPTProviderActivity } from "../chatGPTProviderActivity";
import {
  requestAgentAttention,
  cancelManualAgentAttention,
  priorityChatGPTAttentionTarget,
  loadAgentAttention,
  nextRecentAgentAttentionSessionId,
} from "../chatGPTAgentAttention";
import { toastManager } from "./ui/toast";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import { randomUUID } from "../lib/utils";
import { registerCommands, registerMenuAction } from "../shortcuts/dispatcher";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerKeybindingsAtom } from "../state/server";

/** Handles both T3 keydowns and shortcuts forwarded from focused ChatGPT guests. */
export function ChatGPTNewSessionShortcut() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const environmentId = usePrimaryEnvironmentId();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const lastRecentAttentionTarget = useRef<string | null>(null);
  const { createSession, toggleSessionReturnMarker, setSessionHidden, setSessionSnooze } = useChatGPTBrowserSessions(environmentId);

  const createNewSession = useEffectEvent(() => {
    if (!isElectron || !environmentId) return;
    void navigate({
      to: "/browser/$browserSessionId",
      params: { browserSessionId: createSession(undefined, { explicitlyUserCreated: true }) },
    });
  });

  const toggleSelectedReturnMarker = useEffectEvent(() => {
    if (!isElectron || !environmentId || isCommandPaletteOpen()) return;
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
    const ids = [session.id, ...(session.bootstrapIdentity?.publicId
      ? [session.bootstrapIdentity.publicId] : [])];
    if (session.returnMarker) cancelManualAgentAttention(ids);
    else requestAgentAttention(randomUUID(), session.bootstrapIdentity?.publicId ?? session.id,
      session.title, "manual");
    toastManager.add(
      session.returnMarker
        ? { type: "success", title: "Persistent attention disabled", description: session.title }
        : {
            type: "success",
            title: "Persistent attention enabled",
            description: activity === "working"
              ? `${session.title}: yellow border when this response finishes`
              : `${session.title}: yellow border after the next response finishes`,
          },
    );
  });

  const openLastAttentionSession = useEffectEvent(() => {
    if (!isElectron || !environmentId || isCommandPaletteOpen()) return;
    const sessions = readChatGPTBrowserSessions(environmentId);
    const availableIds = new Set(sessions.flatMap((entry) => [
      entry.id,
      ...(entry.bootstrapIdentity?.publicId ? [entry.bootstrapIdentity.publicId] : []),
    ]));
    const requests = loadAgentAttention();
    // Persistent yellow markers are authoritative even if their one-shot
    // notification is missing. Non-verification attention takes precedence
    // over Verification and historical receipts.
    const target = priorityChatGPTAttentionTarget(sessions.map((entry) => ({
      id: entry.id,
      bootstrapIdentity: entry.bootstrapIdentity,
      verificationPending: entry.verificationPending,
      returnMarker: entry.returnMarker,
      hidden: entry.hidden,
      snoozedUntil: entry.snoozedUntil,
      working: readChatGPTProviderActivity(environmentId, entry.id) === "working",
      lastActiveAt: readChatGPTSessionTimeline(environmentId, entry).lastActiveAt,
    })), requests);
    if (target) {
      const session = sessions.find((entry) =>
        entry.id === target.sessionId ||
        entry.bootstrapIdentity?.publicId === target.sessionId);
      if (!session) return;
      const activity = readChatGPTProviderActivity(environmentId, session.id);
      if (target.requestId) {
        // Opening a notification consumes only that entry, preserving the stack.
        if (!acknowledgeChatGPTSessionAttention(
          environmentId, session, activity, target.requestId,
        )) return;
      } else {
        // A yellow marker can outlive its notification record. Acknowledge the
        // marker without clearing independent waiting agent requests.
        rearmPersistentSessionAttention(environmentId, session, activity);
        markChatGPTAttentionVisited(environmentId, session.id, activity);
      }
      lastRecentAttentionTarget.current = null;
      setSessionHidden(session.id, false);
      setSessionSnooze([session.id], null);
      void navigate({ to: "/browser/$browserSessionId", params: { browserSessionId: session.id } });
      return;
    }
    // Only once NO marked-ready or pending sessions remain does Ctrl+S cycle
    // recent resolved attention receipts.
    const selectedId = pathname.match(/^\/browser\/([^/]+)\/?$/)?.[1];
    const selected = sessions.find((entry) => entry.id === selectedId);
    const workingIds = new Set(sessions.flatMap((entry) =>
      readChatGPTProviderActivity(environmentId, entry.id) === "working"
        ? [entry.id, ...(entry.bootstrapIdentity?.publicId
          ? [entry.bootstrapIdentity.publicId] : [])]
        : []));
    const verificationIds = new Set(sessions.flatMap((entry) =>
      entry.verificationPending
        ? [entry.id, ...(entry.bootstrapIdentity?.publicId
          ? [entry.bootstrapIdentity.publicId] : [])]
        : []));
    const nextId = nextRecentAgentAttentionSessionId(
      requests,
      availableIds,
      selected ? [selected.id, ...(selected.bootstrapIdentity?.publicId
        ? [selected.bootstrapIdentity.publicId] : [])] : [],
      workingIds,
      lastRecentAttentionTarget.current ?? undefined,
      verificationIds,
    );
    const session = sessions.find((entry) =>
      entry.id === nextId || entry.bootstrapIdentity?.publicId === nextId);
    if (!session) {
      lastRecentAttentionTarget.current = null;
      toastManager.add({ type: "info", title: "No recent attention sessions" });
      return;
    }
    lastRecentAttentionTarget.current = nextId ?? null;
    setSessionHidden(session.id, false);
    setSessionSnooze([session.id], null);
    void navigate({ to: "/browser/$browserSessionId", params: { browserSessionId: session.id } });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the desktop shortcut and guest menu action while the app shell is mounted
  useEffect(() => {
    if (!isElectron || !environmentId) return;

    const unregisterKeydown = registerCommands(
      {
        "chatgpt.openLastAttention": (event) => {
          if (event.repeat || event.isComposing || isCommandPaletteOpen() ||
              (event.target instanceof Element && event.target.closest("[data-keybinding-capture]")))
            return false;
          event.preventDefault();
          event.stopPropagation();
          openLastAttentionSession();
          return true;
        },
        "chatgpt.returnMarker": (event) => {
          const sessionId = pathname.match(/^\/browser\/([^/]+)\/?$/)?.[1];
          if (!sessionId || !environmentId || event.repeat || event.isComposing ||
              isCommandPaletteOpen() ||
              (event.target instanceof Element && event.target.closest("[data-keybinding-capture]")))
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
          if (event.key.toLowerCase() !== "s" || !event.ctrlKey || event.metaKey ||
              event.altKey || event.shiftKey || event.repeat || event.isComposing ||
              isCommandPaletteOpen() ||
              (event.target instanceof Element && event.target.closest("[data-keybinding-capture]")))
            return false;
          event.preventDefault();
          event.stopPropagation();
          openLastAttentionSession();
          return true;
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
    const unregisterOpenLastAttentionAction = registerMenuAction("chatgpt.open-last-attention",
      () => { openLastAttentionSession(); });
    return () => {
      unregisterKeydown();
      unregisterMenuAction();
      unregisterReturnMarkerAction();
      unregisterOpenLastAttentionAction();
    };
  }, [environmentId, keybindings, pathname]);

  return null;
}
