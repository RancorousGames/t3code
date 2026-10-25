import type { BrowserSession } from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";

export type ChatGPTRolloverPlan = {
  priorId: string;
  successorId: string;
  priorConversationId: string;
  successorConversationId: string;
  priorConversationUrl: string;
  archivedAt: string;
};

/** One local-storage transition: the successor inherits the manager's position,
 * direct children move once, and the predecessor becomes a restorable archive.
 * OpenRig remains responsible for the durable same-seat primary CAS and queue. */
export function finalizeChatGPTRolloverHierarchy(
  sessions: readonly BrowserSession[],
  plan: ChatGPTRolloverPlan,
): BrowserSession[] {
  const { priorId, successorId } = plan;
  if (!priorId || !successorId || priorId === successorId)
    throw new Error("Rollover needs two distinct exact T3 browser IDs.");
  if (sessions.filter((s) => s.id === priorId).length !== 1 ||
      sessions.filter((s) => s.id === successorId).length !== 1)
    throw new Error("Both exact T3 browser sessions must exist uniquely.");
  const prior = sessions.find((s) => s.id === priorId)!;
  const successor = sessions.find((s) => s.id === successorId)!;
  if (successor.hidden) throw new Error("Successor is hidden.");
  const priorConversationUrl = `https://chatgpt.com/c/${plan.priorConversationId}`;
  if (plan.priorConversationUrl !== priorConversationUrl ||
      chatGPTConversationIdFromUrl(priorConversationUrl) !== plan.priorConversationId ||
      !chatGPTConversationIdFromUrl(`https://chatgpt.com/c/${plan.successorConversationId}`))
    throw new Error("Rollover requires two exact verified canonical conversations.");
  if (!Number.isFinite(Date.parse(plan.archivedAt)))
    throw new Error("Rollover archive time invalid.");
  if (prior.hidden && (!prior.archive || prior.archive.restoredAt ||
      prior.archive.conversationUrl !== priorConversationUrl))
    throw new Error("Predecessor is hidden without a matching durable archive.");

  const currentParent = successor.parentSessionId ?? null;
  const originalParent = prior.parentSessionId ?? null;
  // Fresh rollover: successor is the prior's child. Repeated requests with
  // already-reparented metadata are harmless; arbitrary cross-tree moves aren't.
  if (currentParent !== priorId && currentParent !== originalParent)
    throw new Error("Successor was not linked to this predecessor.");
  if (originalParent === successorId || originalParent === priorId)
    throw new Error("Invalid predecessor ancestry.");

  const byId = new Map(sessions.map((s) => [s.id, s]));
  let cursor = originalParent;
  const ancestors = new Set<string>([successorId]);
  while (cursor) {
    if (ancestors.has(cursor)) throw new Error("Rollover would create a parent cycle.");
    ancestors.add(cursor);
    cursor = byId.get(cursor)?.parentSessionId ?? null;
  }

  return sessions.map((s) => {
    if (s.id === successorId)
      return { ...s, parentSessionId: originalParent, project: prior.project ?? s.project };
    if (s.id === priorId)
      return {
        ...s,
        hidden: true,
        hiddenAt: s.hiddenAt ?? Date.parse(plan.archivedAt),
        archive: s.archive && !s.archive.restoredAt ? s.archive : {
          archivedAt: plan.archivedAt,
          conversationUrl: priorConversationUrl,
          basis: "manager_decision" as const,
          reason: `OpenRig same-seat rollover to T3 session ${successorId}`,
        },
      };
    if (s.parentSessionId === priorId)
      return { ...s, parentSessionId: successorId };
    return s;
  });
}
