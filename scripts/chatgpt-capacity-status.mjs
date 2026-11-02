/** T3 owns the definition of an active ChatGPT worker. OpenRig only receives
 * this read-only projection and arbitrates its own atomic start reservations.
 * This is a soft concurrency target: idle/error/unknown sessions take no slot. */
export function computeChatGPTCapacityStatus(inventory, now = Date.now()) {
  if (!inventory || !Array.isArray(inventory.sessions)) {
    throw new Error("T3 capacity requires a session inventory.");
  }
  const sessions = inventory.sessions;
  const complete = (typeof inventory.total !== "number" || inventory.total === sessions.length) &&
    inventory.hasMore !== true && inventory.truncated !== true &&
    inventory.incomplete !== true && inventory.nextCursor == null;
  const ids = new Set();
  const workingSessionIds = [];
  const projected = [];
  const errorStatuses = new Set(["pending_or_stalled", "stuck", "stuck_connecting", "unavailable"]);
  for (const entry of sessions) {
    if (!entry || typeof entry.id !== "string" || ids.has(entry.id))
      throw new Error("T3 capacity received a duplicate/invalid session identity.");
    ids.add(entry.id);
    const observedAt = Date.parse(entry.statusObservedAt ?? "");
    const fresh = Number.isFinite(observedAt) &&
      observedAt <= now + 1_000 && now - observedAt <= 15_000;
    // An old 'working' badge is not evidence of a still-active assistant.
    const working = fresh && (entry.activity === "working" || entry.status === "working");
    if (working) workingSessionIds.push(entry.id);
    projected.push({
      id: entry.id,
      state: working ? "working" : errorStatuses.has(entry.status) ? "error" : "idle",
      status: typeof entry.status === "string" ? entry.status : "unknown",
      activity: typeof entry.activity === "string" ? entry.activity : "unknown",
      observedAt: Number.isFinite(observedAt) ? entry.statusObservedAt : null,
    });
  }
  return {
    version: 1,
    authority: "t3",
    observedAt: new Date(now).toISOString(),
    complete,
    totalSessions: sessions.length,
    working: workingSessionIds.length,
    workingSessionIds,
    sessions: projected,
  };
}
