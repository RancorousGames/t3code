import type * as Electron from "electron";

export const RETURN_CHATGPT_SESSION_MENU_ACTION = "chatgpt.return-marker";
export const OPEN_LAST_CHATGPT_ATTENTION_MENU_ACTION = "chatgpt.open-last-attention";

/** Route ChatGPT webview-focus shortcuts through the desktop owner. */
export function chatGPTAttentionShortcutAction(
  input: Pick<Electron.Input, "type" | "key" | "meta" | "control" | "alt" | "shift">,
): string | null {
  if (isFourHourCaffyShortcut(input)) return "caffy:quick-4h";
  if (isChatGPTReturnMarkerShortcut(input)) return RETURN_CHATGPT_SESSION_MENU_ACTION;
  if (
    input.type === "keyDown" &&
    input.control &&
    !input.meta &&
    !input.alt &&
    !input.shift &&
    input.key.toLowerCase() === "s"
  )
    return OPEN_LAST_CHATGPT_ATTENTION_MENU_ACTION;
  return null;
}

export function isFourHourCaffyShortcut(
  input: Pick<Electron.Input, "type" | "key" | "meta" | "control" | "alt" | "shift">,
): boolean {
  return (
    input.type === "keyDown" &&
    input.control &&
    input.alt &&
    !input.meta &&
    !input.shift &&
    input.key.toLowerCase() === "i"
  );
}

/** Ctrl+D arms the selected ChatGPT session's Return marker. */
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
