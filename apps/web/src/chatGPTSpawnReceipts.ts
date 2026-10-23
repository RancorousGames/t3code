import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const SpawnReceipt = Schema.Struct({
  requestId: Schema.String,
  environmentId: Schema.String,
  sessionId: Schema.String,
  createdAt: Schema.Number,
});
const SpawnReceipts = Schema.Array(SpawnReceipt);
type SpawnReceipt = typeof SpawnReceipt.Type;
const STORAGE_KEY = "t3code:chatgpt-browser:spawn-receipts:v1";

// Stored immediately after createSession. The broker may lose its renderer
// response later; a read-only sessions.list can still correlate the UUID.
export function recordChatGPTSpawnCreated(
  environmentId: EnvironmentId,
  requestId: string,
  sessionId: string,
): void {
  const current = getLocalStorageItem(STORAGE_KEY, SpawnReceipts) ?? [];
  const next: SpawnReceipt[] = [
    ...current.filter((receipt) => receipt.requestId !== requestId),
    { requestId, environmentId, sessionId, createdAt: Date.now() },
  ].slice(-256);
  setLocalStorageItem(STORAGE_KEY, next, SpawnReceipts);
}

export function readChatGPTSpawnReceipts(environmentId: EnvironmentId): readonly SpawnReceipt[] {
  return (getLocalStorageItem(STORAGE_KEY, SpawnReceipts) ?? []).filter(
    (receipt) => receipt.environmentId === environmentId,
  );
}
