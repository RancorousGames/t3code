/** Defer mouse single-click effects until the OS double-click sequence can finish. */
export const CHATGPT_SESSION_CLICK_SETTLE_MS = 500;

export interface ChatGPTSessionClickTimer {
  current: ReturnType<typeof setTimeout> | null;
}

/** A second mouse click can cancel the first click's navigation/unsnooze effects. */
export function cancelChatGPTSessionSingleClick(timer: ChatGPTSessionClickTimer): void {
  if (timer.current !== null) clearTimeout(timer.current);
  timer.current = null;
}

export function scheduleChatGPTSessionSingleClick(
  timer: ChatGPTSessionClickTimer,
  callback: () => void,
): void {
  cancelChatGPTSessionSingleClick(timer);
  timer.current = setTimeout(() => {
    timer.current = null;
    callback();
  }, CHATGPT_SESSION_CLICK_SETTLE_MS);
}

/** Double-click is an explicit 24-hour snooze, irrespective of the session's activity. */
export function chatGPTDoubleClickSnoozeUntil(now: number): number {
  return now + 24 * 60 * 60_000;
}
