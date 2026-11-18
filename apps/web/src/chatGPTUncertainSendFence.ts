import type { EnvironmentId } from "@t3tools/contracts";

/**
 * In-flight send tracking for ChatGPT guests.
 *
 * Delivery is at-least-once: the desktop outbox retries a message until its
 * marked user turn is observed, and duplicates are acceptable. Nothing here
 * blocks a later send. The only purpose is to keep reloads, unloads and
 * cleanups from pulling a guest away while a send is running right now
 * (a few seconds), via `hasUncertainChatGPTSend` in chatGPTSessionControl.
 */
const inFlight = new Map<string, number>();
const keyFor = (environmentId: EnvironmentId, sessionId: string) => `${environmentId}:${sessionId}`;

/** Mark a send as running; call the returned function when it settles. */
export function beginChatGPTSend(environmentId: EnvironmentId, sessionId: string): () => void {
  const key = keyFor(environmentId, sessionId);
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left > 0) inFlight.set(key, left);
    else inFlight.delete(key);
  };
}

export function isChatGPTSendInFlight(environmentId: EnvironmentId, sessionId: string): boolean {
  return inFlight.has(keyFor(environmentId, sessionId));
}

export function clearChatGPTSendsInFlightForTests(): void {
  inFlight.clear();
}

// Older builds persisted permanent per-session UNKNOWN fences that blocked every
// later send until a human reconciled them. Drop them so those sessions recover.
const LEGACY_PREFIXES = [
  "t3code:chatgpt-unknown-send-fence:v1:",
  "t3code:chatgpt-confirmed-delivery:v1:",
];
export function purgeLegacyChatGPTSendFences(): void {
  try {
    const storage = window.localStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key && LEGACY_PREFIXES.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* Storage unavailable: nothing to purge. */
  }
}
