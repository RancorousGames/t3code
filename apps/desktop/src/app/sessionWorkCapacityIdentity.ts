/**
 * Resolve the immutable browser UUID and public Bootstrap T3_ID to the same
 * working-session slot. A verified idle-event prefix is also a browser UUID.
 * Ambiguous aliases are deliberately NOT collapsed: counting twice is safer
 * than admitting an extra worker into an unknown slot.
 */
export interface WorkCapacitySessionIdentity {
  id?: string | undefined;
  browserSessionId?: string | undefined;
  publicSessionId?: string | undefined;
  conversationId?: string | null | undefined;
  bootstrapIdentity?: { publicId?: string | undefined; conversationId?: string | undefined } | undefined;
  lastIdleTransition?: { eventId?: string | undefined; conversationId?: string | undefined } | undefined;
}

const SESSION_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function sessionWorkCapacityIdentityResolver(
  sessions: readonly WorkCapacitySessionIdentity[],
): (sessionId: string) => string {
  const candidates = new Map<string, Set<string>>();
  for (const session of sessions) {
    const canonicalId = session.id;
    if (!canonicalId) continue;
    const aliases: (string | undefined)[] = [
      canonicalId, session.browserSessionId, session.publicSessionId,
      session.bootstrapIdentity?.publicId,
    ];
    const idle = session.lastIdleTransition;
    if (idle?.eventId && idle.conversationId &&
        idle.conversationId === (session.conversationId ??
          session.bootstrapIdentity?.conversationId)) {
      const browserId = idle.eventId.split(":")[0];
      if (browserId && SESSION_UUID.test(browserId)) aliases.push(browserId);
    }
    for (const alias of aliases) {
      if (!alias) continue;
      let owners = candidates.get(alias);
      if (!owners) { owners = new Set(); candidates.set(alias, owners); }
      owners.add(canonicalId);
    }
  }
  return (sessionId) => {
    const owners = candidates.get(sessionId);
    return owners?.size === 1 ? owners.values().next().value! : sessionId;
  };
}
