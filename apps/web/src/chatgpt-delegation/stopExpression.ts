export function delegatedChatGPTStopExpression(conversationId: string): string {
  return `(() => {
    if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com' || location.pathname.replace(/\\/$/, '') !== ${JSON.stringify("/c/" + conversationId)}) throw new Error('ChatGPT conversation changed before Stop.');
    const button = document.querySelector('button[data-testid="stop-button"],button[data-testid="composer-stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled || !button.getClientRects().length) return false;
    button.click(); return true;
  })()`;
}
