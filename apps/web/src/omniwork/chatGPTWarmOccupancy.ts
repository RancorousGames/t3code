import { chatGPTGuestKey } from "../browser/chatGPTGuestHibernation";

export interface WarmOccupancySession {
  readonly id: string;
  readonly threadId: string;
  /** A runtime is requested; this does not establish that a webview exists. */
  readonly mountEligible: boolean;
  readonly hibernated: boolean;
  /** Healthy status requires an actual guest probe, not merely permission to mount. */
  readonly activity?: string;
}

export interface WarmOccupancySnapshot {
  readonly mountEligibleIds: ReadonlySet<string>;
  /** Physical DOM webviews attached to this environment/thread. */
  readonly mountedIds: ReadonlySet<string>;
  /** Attached guests for which the activity monitor has observed a valid conversation. */
  readonly verifiedLoadedIds: ReadonlySet<string>;
  /** Recent explicit warm requests, reserved until attachment or timeout. */
  readonly pendingIds: ReadonlySet<string>;
  /** Physical webviews plus bounded pending reservations; never all mount-eligible guests. */
  readonly occupiedIds: ReadonlySet<string>;
}

const PENDING_MOUNT_MS = 120_000;

/** A physical multi-session occupancy snapshot, independent of React mount permission.
 * Snapshot only: callers must refresh DOM membership when scheduling each new warm request.
 */
export function snapshotWarmSessionOccupancy(input: {
  readonly environmentId: string;
  readonly sessions: readonly WarmOccupancySession[];
  readonly mountedRuntimeTabIds: readonly string[];
  readonly loadingAt: Readonly<Record<string, number>>;
  readonly now: number;
}): WarmOccupancySnapshot {
  const { environmentId, sessions, mountedRuntimeTabIds, loadingAt, now } = input;
  const physicalKeys = new Set(mountedRuntimeTabIds.map(chatGPTGuestKey));
  const mountEligibleIds = new Set<string>();
  const mountedIds = new Set<string>();
  const verifiedLoadedIds = new Set<string>();
  const pendingIds = new Set<string>();
  for (const session of sessions) {
    if (!session.mountEligible || session.hibernated) continue;
    mountEligibleIds.add(session.id);
    const key = JSON.stringify([environmentId, session.threadId]);
    if (physicalKeys.has(key)) {
      mountedIds.add(session.id);
      if (["working", "recent", "inactive"].includes(session.activity ?? ""))
        verifiedLoadedIds.add(session.id);
    } else {
      const startedAt = loadingAt[JSON.stringify([environmentId, session.id])];
      if (typeof startedAt === "number" && startedAt > 0 && now >= startedAt &&
        now - startedAt < PENDING_MOUNT_MS)
        pendingIds.add(session.id);
    }
  }
  return {
    mountEligibleIds, mountedIds, verifiedLoadedIds, pendingIds,
    occupiedIds: new Set([...mountedIds, ...pendingIds]),
  };
}
