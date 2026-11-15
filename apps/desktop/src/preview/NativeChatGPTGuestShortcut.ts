import type * as Electron from "electron";

import {
  activeChatGPTBrowserSessionId,
  CLOSE_CHATGPT_SESSION_MENU_ACTION,
  isChatGPTCloseShortcut,
  isChatGPTRenameShortcut,
  RENAME_CHATGPT_SESSION_MENU_ACTION,
} from "../window/ChatGPTCloseShortcut.ts";

export const FIND_CHATGPT_MENU_ACTION = "chatgpt.find";
export const RETURN_CHATGPT_SESSION_MENU_ACTION = "chatgpt.return-marker";
export const OPEN_LAST_CHATGPT_ATTENTION_MENU_ACTION = "chatgpt.open-last-attention";

export function chatGPTAttentionShortcutAction(
  input: Pick<Electron.Input, "type" | "key" | "meta" | "control" | "alt" | "shift">,
): string | null {
  if (isChatGPTReturnMarkerShortcut(input)) return RETURN_CHATGPT_SESSION_MENU_ACTION;
  if (input.type === "keyDown" && input.control && !input.meta &&
      !input.alt && !input.shift && input.key.toLowerCase() === "s")
    return OPEN_LAST_CHATGPT_ATTENTION_MENU_ACTION;
  return null;
}


/** Ctrl+D is a direct desktop command while a ChatGPT session owns focus. */
export function isChatGPTReturnMarkerShortcut(
  input: Pick<Electron.Input, "type" | "key" | "meta" | "control" | "alt" | "shift">,
): boolean {
  return (
    input.type === "keyDown" &&
    input.control &&
    !input.meta &&
    !input.alt &&
    !input.shift &&
    input.key.toLowerCase() === "d"
  );
}

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
  if (isChatGPTRenameShortcut(input)) return RENAME_CHATGPT_SESSION_MENU_ACTION;
  const attentionAction = chatGPTAttentionShortcutAction(input);
  if (attentionAction) return attentionAction;
  const modifier =
    platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (
    input.type === "keyDown" &&
    modifier &&
    !input.alt &&
    !input.shift &&
    input.key.toLowerCase() === "f"
  )
    return FIND_CHATGPT_MENU_ACTION;
  return null;
}

/** Replay a key pressed inside a guest page as a keydown on T3's window, so T3's
 * own keybinding handling sees it while the page keeps keyboard focus. */
export function dispatchChatGPTGuestKeyToOwner(
  owner: Electron.BrowserWindow,
  input: Pick<
    Electron.Input,
    "key" | "code" | "control" | "meta" | "shift" | "alt" | "isAutoRepeat"
  >,
): void {
  const options = JSON.stringify({
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    metaKey: input.meta,
    shiftKey: input.shift,
    altKey: input.alt,
    repeat: input.isAutoRepeat,
  });
  void owner.webContents
    .executeJavaScript(
      `window.dispatchEvent(new KeyboardEvent("keydown", { ...${options}, bubbles: true, cancelable: true }))`,
      false,
    )
    .catch(() => undefined);
}
