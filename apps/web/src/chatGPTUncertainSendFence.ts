import type { EnvironmentId } from "@t3tools/contracts";

const PREFIX = "t3code:chatgpt-unknown-send-fence:v1:";
const ARCHIVED_LEGACY_PREFIX = "t3code:chatgpt-legacy-unknown-archive:v1:";
const keyFor = (environmentId: EnvironmentId, sessionId: string) =>
  `${PREFIX}${environmentId}:${sessionId}`;

export interface DurableChatGPTSend {
  readonly text: string;
  readonly original: string;
  readonly url: string;
  readonly before: { readonly totalTurns: number; readonly lastUserTurnKey: string | null };
  readonly policyEnrichment: {
    schema: "t3-c05-browser-optional/v1";
    status: "deferred" | "not_eligible" | "prepared" | "observed_user_turn";
    reason?: string;
    qitemIds?: string[];
  };
}

/** Keep the reconciliation evidence alongside the reservation. A marker alone
 * survives a restart but permanently loses the means to confirm delivery. */
export function readDurableUnknownChatGPTSend(environmentId: EnvironmentId, sessionId: string):
  { conversationUrl: string; reservedAt: number; attempt?: DurableChatGPTSend } | null {
  const raw = window.localStorage.getItem(keyFor(environmentId, sessionId));
  if (raw === null) return null;
  const receipt = JSON.parse(raw);
  if (![1, 2].includes(receipt.version) || typeof receipt.conversationUrl !== "string" ||
      !Number.isFinite(receipt.reservedAt)) throw new Error("Unreadable UNKNOWN send receipt.");
  if (receipt.version === 2) {
    const a = receipt.attempt;
    if (!a || typeof a.text !== "string" || typeof a.original !== "string" ||
        a.url !== receipt.conversationUrl || !Number.isFinite(a.before?.totalTurns) ||
        !(a.before.lastUserTurnKey === null || typeof a.before.lastUserTurnKey === "string") ||
        a.policyEnrichment?.schema !== "t3-c05-browser-optional/v1")
      throw new Error("Unreadable UNKNOWN send evidence.");
  }
  return receipt;
}

/** An unresolved send may already have reached ChatGPT. Never replay it. */
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
  attempt?: DurableChatGPTSend,
): void {
  const key = keyFor(environmentId, sessionId);
  try {
    const existing = window.localStorage.getItem(key);
    if (existing !== null && !replaceExisting) {
      throw new Error(
        "An unresolved send receipt survived an earlier renderer; reconcile manually.",
      );
    }
    const receipt = JSON.stringify({ version: attempt ? 2 : 1, conversationUrl,
      reservedAt: Date.now(), ...(attempt ? { attempt } : {}) });
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

/**
 * Legacy v1 fences stored no message bytes, so their original delivery cannot
 * be reconciled automatically. Preserve that uncertainty in an independent
 * durable archive instead of letting it block every future, distinct send.
 * Caller must first prove exact conversation, idle state and empty composer.
 * Never use this for v2 fences: those carry evidence for normal reconciliation.
 */
export function archiveLegacyUnknownChatGPTSend(
  environmentId: EnvironmentId,
  sessionId: string,
  exactUrl: string,
  now = Date.now(),
): boolean {
  const key = keyFor(environmentId, sessionId);
  const current = readDurableUnknownChatGPTSend(environmentId, sessionId);
  if (!current || current.attempt || current.conversationUrl !== exactUrl ||
      now - current.reservedAt < 60_000) return false;
  const archiveKey = ARCHIVED_LEGACY_PREFIX + environmentId + ":" + sessionId;
  const prior = window.localStorage.getItem(archiveKey);
  const entry = JSON.stringify({ ...current, reason: "legacy_payload_missing; original_delivery_unresolved",
    archivedAt: now });
  // Write and verify the archive BEFORE removing the active fence.
  window.localStorage.setItem(archiveKey, prior ? prior + "\n" + entry : entry);
  if (window.localStorage.getItem(archiveKey) !== (prior ? prior + "\n" + entry : entry))
    throw new Error("Could not persist legacy UNKNOWN evidence; send remains blocked.");
  window.localStorage.removeItem(key);
  if (window.localStorage.getItem(key) !== null)
    throw new Error("Could not release legacy UNKNOWN fence; send remains blocked.");
  return true;
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
