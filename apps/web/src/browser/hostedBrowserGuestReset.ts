export interface BrowserGuestResetResult {
  readonly previousWebContentsId: number;
  readonly webContentsId: number;
}

type ResetGuest = (url?: string) => Promise<BrowserGuestResetResult>;
const resetters = new Map<string, ResetGuest>();

/** The host owns this operation: it must work when guest JavaScript cannot run. */
export function registerHostedBrowserGuestReset(runtimeTabId: string, reset: ResetGuest) {
  resetters.set(runtimeTabId, reset);
  return () => {
    if (resetters.get(runtimeTabId) === reset) resetters.delete(runtimeTabId);
  };
}

/** Resolves after a different guest has registered, not after ChatGPT has loaded. */
export function resetHostedBrowserGuest(runtimeTabId: string, url?: string) {
  const reset = resetters.get(runtimeTabId);
  if (!reset) return Promise.reject(new Error("The browser instance is not attached here."));
  return reset(url);
}
