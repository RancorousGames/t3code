import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { useChatGPTBrowserSessions } from "../chatGPTBrowserSessions";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { isElectron } from "../env";
import { registerCommands, registerMenuAction } from "../shortcuts/dispatcher";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerKeybindingsAtom } from "../state/server";

/** Handles both T3 keydowns and shortcuts forwarded from focused ChatGPT guests. */
export function ChatGPTNewSessionShortcut() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const environmentId = usePrimaryEnvironmentId();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { createSession } = useChatGPTBrowserSessions(environmentId);

  const createNewSession = useEffectEvent(() => {
    if (!isElectron || !environmentId) return;
    void navigate({
      to: "/browser/$browserSessionId",
      params: { browserSessionId: createSession(undefined, { explicitlyUserCreated: true }) },
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the desktop shortcut and guest menu action while the app shell is mounted
  useEffect(() => {
    if (!isElectron || !environmentId) return;

    const unregisterKeydown = registerCommands(
      {
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
    return () => {
      unregisterKeydown();
      unregisterMenuAction();
    };
  }, [environmentId, keybindings, pathname]);

  return null;
}
