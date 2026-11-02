import type { DesktopOpenRigSeatSessions, DesktopOpenRigSeatTopology } from "@t3tools/contracts";
import type { BrowserSession } from "../../chatGPTBrowserSessions";
import { chatGPTSessionDisplayRole } from "./chatGPTSidebarVisuals";

/**
 * A persisted manager marker is only a last-verified OpenRig seat binding.
 * Legacy known-manager UUIDs and browser titles are deliberately excluded.
 */
export interface CachedOpenRigManagerBinding {
  readonly t3SessionId: string;
  readonly conversationId: string | null;
  readonly seatId: string | null;
  readonly managedSessionId: string | null;
  readonly role: string;
  readonly roleSource: string | null;
  readonly status: string;
}

/**
 * Fresh complete OpenRig evidence always replaces the stale snapshot, including
 * the empty set after seat revocation/transfer. During an outage, restore only
 * an exact last-verified seat + conversation match (never a bare tab UUID).
 */
export function projectOpenRigManagerTabIds(
  sessions: readonly BrowserSession[],
  authoritativeIds: ReadonlySet<string> | null,
  cachedBindings: readonly CachedOpenRigManagerBinding[],
  observedConversationIds: ReadonlyMap<string, string | null>,
): ReadonlySet<string> {
  const knownTabs = new Set(sessions.map((session) => session.id));
  if (authoritativeIds !== null)
    return new Set([...authoritativeIds].filter((id) => knownTabs.has(id)));

  return new Set(
    cachedBindings.flatMap((binding) =>
      binding.role === "manager" &&
      binding.roleSource === "openrig-rigspec" &&
      (binding.status === "verified" || binding.status === "stale_verified") &&
      !!binding.seatId &&
      !!binding.managedSessionId &&
      !!binding.conversationId &&
      knownTabs.has(binding.t3SessionId) &&
      observedConversationIds.get(binding.t3SessionId) === binding.conversationId
        ? [binding.t3SessionId]
        : [],
    ),
  );
}

/**
 * While ledgers are down, do not infer a fresh worker from backend origin.
 * Only previously verified worker receipts can be hidden; a manager's newly
 * confirmed or exact last-verified seat always outranks such a receipt.
 */
export function projectHideableWorkerIds(
  sessions: readonly BrowserSession[],
  authoritativeIds: ReadonlySet<string> | null,
  managerIds: ReadonlySet<string>,
  verifiedWorkerIds: ReadonlySet<string>,
): ReadonlySet<string> {
  if (authoritativeIds === null)
    return new Set(
      [
        ...verifiedWorkerIds,
        ...sessions
          .filter((session) => session.markedAsWorkerAt !== undefined)
          .map((session) => session.id),
      ].filter((id) => !managerIds.has(id)),
    );
  return new Set(
    sessions.flatMap((session) =>
      chatGPTSessionDisplayRole(session, managerIds.has(session.id)) === "worker"
        ? [session.id]
        : [],
    ),
  );
}

/** Keep only exact RigSpec + ACTIVE PRIMARY evidence; never persist a bare manager tab ID. */
export const managerRoleSnapshotKey = (environmentId: string) =>
  `t3code:chatgpt-browser:verified-manager-bindings:${environmentId}`;

export function readManagerRoleSnapshot(raw: string | null): CachedOpenRigManagerBinding[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is CachedOpenRigManagerBinding =>
        item &&
        typeof item === "object" &&
        typeof item.t3SessionId === "string" &&
        typeof item.conversationId === "string" &&
        typeof item.seatId === "string" &&
        typeof item.managedSessionId === "string" &&
        item.role === "manager" &&
        item.roleSource === "openrig-rigspec" &&
        item.status === "verified",
    );
  } catch {
    return [];
  }
}

/** Called only after *complete* fresh ledger readback. This also stores an empty list after revocation. */
export function captureVerifiedManagerBindings(
  topology: DesktopOpenRigSeatTopology,
  ledgers: readonly DesktopOpenRigSeatSessions[],
  environmentId: string,
  verifiedIds: ReadonlySet<string>,
): CachedOpenRigManagerBinding[] {
  const result: CachedOpenRigManagerBinding[] = [];
  for (const seat of topology.seats) {
    const ledger = ledgers.find((entry) => entry.seatId === seat.id);
    const current = ledger?.sessions.find(
      (entry) => entry.primary && entry.id === ledger.primarySessionId,
    );
    if (
      !current?.attachedTabUuid ||
      !verifiedIds.has(current.attachedTabUuid) ||
      current.status !== "active" ||
      current.target?.kind !== "chatgpt-conversation" ||
      !current.target.conversationId ||
      (current.environmentId && current.environmentId !== environmentId)
    )
      continue;
    result.push({
      t3SessionId: current.attachedTabUuid,
      conversationId: current.target.conversationId,
      seatId: seat.id,
      managedSessionId: current.id,
      role: "manager",
      roleSource: "openrig-rigspec",
      status: "verified",
    });
  }
  return result;
}
