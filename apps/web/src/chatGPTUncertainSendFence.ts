import type { EnvironmentId } from "@t3tools/contracts";

const PREFIX = "t3code:chatgpt-unknown-send-fence:v1:";
const keyFor = (environmentId: EnvironmentId, sessionId: string) =>
  `${PREFIX}${environmentId}:${sessionId}`;

/** A payload-free tombstone survives renderer restart. An unresolved send may
 * already have reached ChatGPT; loss of the in-memory text is not permission to
 * navigate away or click another Send button. */
export function hasDurableUnknownChatGPTSend(
  environmentId: EnvironmentId,
  sessionId: string,
): boolean {
  try {
    return window.localStorage.getItem(keyFor(environmentId, sessionId)) !== null;
  } catch {
    return true; // Storage is unreadable: fail closed.
  }
}

/** Record before the irreversible click; verify persistence before returning. */
export function reserveDurableUnknownChatGPTSend(
  environmentId: EnvironmentId,
  sessionId: string,
  conversationUrl: string,
  replaceExisting: boolean,
): void {
  const key = keyFor(environmentId, sessionId);
  try {
    const existing = window.localStorage.getItem(key);
    if (existing !== null && !replaceExisting) {
      throw new Error(
        "An unresolved send receipt survived an earlier renderer; reconcile manually.",
      );
    }
    const receipt = JSON.stringify({ version: 1, conversationUrl, reservedAt: Date.now() });
    window.localStorage.setItem(key, receipt);
    if (window.localStorage.getItem(key) !== receipt)
      throw new Error("Persistence did not confirm the send fence.");
  } catch (error) {
    throw new Error(
      "Could not durably reserve the UNKNOWN send before clicking; nothing was submitted.",
      {
        cause: error,
      },
    );
  }
}

/** Only invoke after observing the original exact sent turn. */
export function releaseDurableUnknownChatGPTSend(
  environmentId: EnvironmentId,
  sessionId: string,
): void {
  const key = keyFor(environmentId, sessionId);
  window.localStorage.removeItem(key);
  if (window.localStorage.getItem(key) !== null) {
    throw new Error("Uncertain send tombstone remains; refuse destructive refresh.");
  }
}

export function clearDurableUnknownChatGPTSendsForTests(): void {
  if (import.meta.env.MODE !== "test") throw new Error("Test-only reset refused.");
  const storage = window.localStorage;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}
