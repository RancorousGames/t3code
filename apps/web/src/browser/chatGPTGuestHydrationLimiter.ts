import { chatGPTConversationIdFromUrl } from "../chatGPTConversationIdentity";

// Only restored T3-owned ChatGPT conversations are paced. Ordinary browser
// previews and brand-new ChatGPT pages must remain responsive.
export function shouldStaggerChatGPTGuest(threadId: string, url: string | null): boolean {
  return threadId.startsWith("t3-browser-session:") && chatGPTConversationIdFromUrl(url) !== null;
}

export const CHATGPT_GUEST_START_SPACING_MS = 12_000;

interface PendingGuest {
  readonly id: string;
  readonly resolve: (allowed: boolean) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

/** Paces actual Electron guest attachment, including server-restored tabs. */
export function createChatGPTGuestHydrationLimiter(spacingMs = CHATGPT_GUEST_START_SPACING_MS) {
  let nextStartAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pending: PendingGuest[] = [];

  const complete = (entry: PendingGuest, allowed: boolean) => {
    entry.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve(allowed);
  };

  const pump = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending.length === 0) return;

    const now = Date.now();
    if (now < nextStartAt) {
      timer = setTimeout(pump, nextStartAt - now);
      return;
    }
    const entry = pending.shift()!;
    nextStartAt = now + spacingMs;
    complete(entry, true);
    pump();
  };

  return {
    request(id: string, signal: AbortSignal): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const entry: PendingGuest = {
          id,
          resolve,
          signal,
          onAbort: () => {
            const index = pending.indexOf(entry);
            if (index < 0) return;
            pending.splice(index, 1);
            complete(entry, false);
            pump();
          },
        };
        pending.push(entry);
        signal.addEventListener("abort", entry.onAbort, { once: true });
        pump();
      });
    },
    // The foreground tab must not wait behind dozens of old background tabs.
    prioritize(id: string): void {
      const index = pending.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      const [entry] = pending.splice(index, 1);
      if (!entry) return;
      nextStartAt = Date.now() + spacingMs;
      complete(entry, true);
      pump();
    },
  };
}

export const chatGPTGuestHydrationLimiter = createChatGPTGuestHydrationLimiter();
