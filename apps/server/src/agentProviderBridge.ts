import type { AgentProviderV1Session } from "@t3tools/contracts";

// The desktop renderer owns the browser-session catalog. This is a short-lived
// presence bridge, not persisted conversation state or a second message queue.
const LEASE_MS = 75_000;
const desktopCatalogs = new Map<
  string,
  {
    environmentId: string;
    updatedAt: number;
    sessions: ReadonlyArray<AgentProviderV1Session>;
  }
>();

export const agentProviderEpoch = globalThis.crypto.randomUUID();

export function publishDesktopCatalog(
  connectionId: string,
  environmentId: string,
  sessions: ReadonlyArray<AgentProviderV1Session>,
): void {
  desktopCatalogs.set(connectionId, {
    environmentId,
    updatedAt: Date.now(),
    sessions,
  });
}

export function disconnectDesktopCatalog(connectionId: string): void {
  desktopCatalogs.delete(connectionId);
}

export function readDesktopCatalog(environmentId: string): ReadonlyArray<AgentProviderV1Session> {
  const now = Date.now();
  const merged = new Map<string, AgentProviderV1Session>();
  for (const [owner, catalog] of desktopCatalogs) {
    if (now - catalog.updatedAt > LEASE_MS) {
      desktopCatalogs.delete(owner);
      continue;
    }
    if (catalog.environmentId !== environmentId) continue;
    for (const session of catalog.sessions) merged.set(session.ref.id, session);
  }
  return [...merged.values()];
}
