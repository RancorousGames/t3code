/** Startup-only policy: existing sessions load on demand by default.
 *  New sessions, including agent-created workers, still open immediately.
 *  A selected restored session stays eligible after the user switches away.
 */
export interface ChatGPTStartupLoadPlan {
  readonly loadAllRestored: boolean;
  readonly restoredIds: ReadonlySet<string>;
  readonly activatedIds: Set<string>;
}

const startupPlans = new Map<string, ChatGPTStartupLoadPlan>();

export function makeChatGPTStartupLoadPlan(
  restoredIds: readonly string[],
  loadAllRestored = false,
): ChatGPTStartupLoadPlan {
  return {
    loadAllRestored,
    restoredIds: new Set(restoredIds),
    activatedIds: new Set(),
  };
}

/** Captured once per environment per renderer lifetime, not on sidebar remount. */
export function getChatGPTStartupLoadPlan(
  environmentId: string,
  restoredIds: readonly string[],
  loadAllRestored: boolean,
): ChatGPTStartupLoadPlan {
  let plan = startupPlans.get(environmentId);
  if (!plan) {
    plan = makeChatGPTStartupLoadPlan(restoredIds, loadAllRestored);
    startupPlans.set(environmentId, plan);
  }
  return plan;
}

/** Selecting a restored session makes it eligible for the rest of this renderer run. */
export function activateStartupChatGPTSession(environmentId: string, sessionId: string): void {
  startupPlans.get(environmentId)?.activatedIds.add(sessionId);
}

/** A deferred restored session has no guest by design, not a failed load. */
export function isChatGPTStartupSessionDeferred(
  environmentId: string,
  sessionId: string,
): boolean {
  const plan = startupPlans.get(environmentId);
  return !!plan && !plan.loadAllRestored &&
    plan.restoredIds.has(sessionId) && !plan.activatedIds.has(sessionId);
}

export function shouldLoadChatGPTSession(
  plan: ChatGPTStartupLoadPlan,
  sessionId: string,
  selectedId: string | null | undefined,
): boolean {
  if (sessionId === selectedId) plan.activatedIds.add(sessionId);
  return (
    plan.loadAllRestored ||
    !plan.restoredIds.has(sessionId) ||
    plan.activatedIds.has(sessionId)
  );
}
