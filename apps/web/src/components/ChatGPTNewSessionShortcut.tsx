import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { readChatGPTBrowserSessions, useChatGPTBrowserSessions } from "../chatGPTBrowserSessions";
import { acknowledgeChatGPTSessionAttention } from "../chatGPTPersistentAttention";
import { readChatGPTProviderActivity } from "../chatGPTProviderActivity";
import { requestAgentAttention, cancelManualAgentAttention, latestAgentAttention } from "../chatGPTAgentAttention";
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
      "Return to " + session.title + " - its response is ready.", "manual");
    toastManager.add(
      session.returnMarker
        ? { type: "success", title: "Persistent attention disabled", description: session.title }
        : {
            type: "success",
            title: "Persistent attention enabled",
            description: activity === "working"
              ? `${session.title} — yellow border when this response finishes`
              : `${session.title} — yellow border after the next response finishes`,
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
    const latest = latestAgentAttention(availableIds);
    if (!latest) {
      toastManager.add({ type: "info", title: "No sessions currently need attention" });
      return;
    }
    const session = sessions.find((entry) =>
      entry.id === latest.sessionId || entry.bootstrapIdentity?.publicId === latest.sessionId);
    if (!session) return;
    acknowledgeChatGPTSessionAttention(environmentId, session);
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
  }, [environmentId, keybindings, pathname, toggleSessionReturnMarker]);

  return null;
}
