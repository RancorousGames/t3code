import type { BrowserSession } from "./chatGPTBrowserSessions";
import {
  CANONICAL_CHATGPT_CONVERSATION_ID,
  chatGPTConversationIdFromUrl,
} from "./chatGPTConversationIdentity";

interface ArchiveInspection {
  hidden: boolean;
  status: string;
  activity: string;
  observedGuestUrl: string | null;
  totalTurns: number;
  completion: BrowserSession["completion"] | null;
}

/** DOM idleness is not a completion signal. Require a valid persisted marker or an explicit decision. */
export function assertArchivableSession(
  entry: BrowserSession,
  observed: ArchiveInspection,
  managerDecision: boolean,
): void {
  if (entry.hidden || observed.hidden)
    throw new Error(`Session ${entry.id} is hidden and cannot be verified.`);
  if (observed.status !== "done_or_idle" || observed.activity !== "idle")
    throw new Error(`Session ${entry.id} has unsafe/uncertain status ${observed.status}.`);
  const conversationId = chatGPTConversationIdFromUrl(observed.observedGuestUrl);
  if (
    !conversationId ||
    !CANONICAL_CHATGPT_CONVERSATION_ID.test(conversationId) ||
    observed.totalTurns < 1
  )
    throw new Error(`Session ${entry.id} has no verified ChatGPT conversation.`);
  if (!managerDecision && !observed.completion)
    throw new Error(
      `Session ${entry.id} has no valid completion marker; invoke complete first or supply an explicit manager decision.`,
    );
}

/** Live descendant sessions can still be doing work even if a parent is idle. */
export function descendantSessions(
  sessions: readonly BrowserSession[],
  parentId: string,
): BrowserSession[] {
  const children: BrowserSession[] = [];
  const visited = new Set<string>([parentId]);
  let frontier = [parentId];
  while (frontier.length) {
    const parents = new Set(frontier);
    const next: string[] = [];
    for (const session of sessions) {
      if (
        visited.has(session.id) ||
        !session.parentSessionId ||
        !parents.has(session.parentSessionId)
      )
        continue;
      visited.add(session.id);
      children.push(session);
      next.push(session.id);
    }
    frontier = next;
  }
  return children;
}
