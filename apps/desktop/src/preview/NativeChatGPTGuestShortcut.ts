import type * as Electron from "electron";

import {
  activeChatGPTBrowserSessionId,
  CLOSE_CHATGPT_SESSION_MENU_ACTION,
  isChatGPTCloseShortcut,
} from "../window/ChatGPTCloseShortcut.ts";

/** Return a native T3 action only for the guest backing the selected session.
 * A background/prewarmed Chrome page must never close the foreground session. */
export function nativeChatGPTGuestShortcut(
  input: Pick<Electron.Input, "type" | "key" | "meta" | "control" | "alt" | "shift">,
  platform: NodeJS.Platform,
  ownerUrl: string,
  guestSessionId: string,
): string | null {
  if (activeChatGPTBrowserSessionId(ownerUrl) !== guestSessionId) return null;
  if (isChatGPTCloseShortcut(input, platform)) return CLOSE_CHATGPT_SESSION_MENU_ACTION;
  const modifier =
    platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (
    input.type === "keyDown" &&
    modifier &&
    !input.alt &&
    !input.shift &&
    input.key.toLowerCase() === "f"
  )
    return "chatgpt.find";
  return null;
}
