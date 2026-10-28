import type { ScopedThreadRef } from "@t3tools/contracts";

const guests = new Map<string, Map<string, symbol>>();
const listeners = new Set<() => void>();
const key = (thread: ScopedThreadRef) => JSON.stringify([thread.environmentId, thread.threadId]);
const notify = () => listeners.forEach((listener) => listener());

/** Publish actual WebContents attachment; stale detach callbacks cannot remove replacements. */
export function registerHostedBrowserGuestPresence(thread: ScopedThreadRef, runtimeTabId: string) {
  const threadKey = key(thread);
  const token = Symbol();
  const tabs = guests.get(threadKey) ?? new Map<string, symbol>();
  tabs.set(runtimeTabId, token);
  guests.set(threadKey, tabs);
  notify();
  return () => {
    if (tabs.get(runtimeTabId) !== token) return;
    tabs.delete(runtimeTabId);
    if (!tabs.size && guests.get(threadKey) === tabs) guests.delete(threadKey);
    notify();
  };
}
export function hasHostedBrowserGuest(thread: ScopedThreadRef): boolean {
  return (guests.get(key(thread))?.size ?? 0) > 0;
}
export function subscribeHostedBrowserGuestPresence(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
