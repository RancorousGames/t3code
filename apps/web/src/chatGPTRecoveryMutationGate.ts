/**
 * In-renderer serialization for state-changing ChatGPT guest recovery operations.
 *
 * Manual and background mutations are serialized per environment. An unresolved
 * host action may yield the environment lock while retaining an exclusive
 * reservation for its own session, so a broken guest cannot freeze every peer.
 * A rejected acquire never mutates a guest; stale releases cannot revoke newer tokens.
 *
 * Do not release on React unmount while a browser mutation is still in flight:
 * hold the lease until its actual operation settles or an explicit bounded
 * deadline has conclusively ended the operation.
 */
export type RecoveryMutationOrigin = "manual" | "automatic";
export type RecoveryMutationAction = "reload" | "stop" | "continue" | "navigate" | "reset";

interface ActiveMutation {
  readonly token: symbol;
  readonly sessionId: string;
  readonly origin: RecoveryMutationOrigin;
  readonly action: RecoveryMutationAction;
}

const activeByEnvironment = new Map<string, ActiveMutation>();
const unresolvedByEnvironment = new Map<string, Map<string, ActiveMutation>>();

export interface RecoveryMutationLease {
  readonly origin: RecoveryMutationOrigin;
  readonly action: RecoveryMutationAction;
  readonly sessionId: string;
  /** Keep a still-running host action isolated to one session after its UI deadline. */
  yieldToSession(sessionId: string): void;
  release(): void;
}

/** Fail-closed, nonblocking reservation: the caller owns an exclusive slot only on success. */
export function tryAcquireChatGPTRecoveryMutation(
  environmentId: string,
  sessionId: string,
  origin: RecoveryMutationOrigin,
  action: RecoveryMutationAction,
): RecoveryMutationLease | null {
  if (
    !environmentId ||
    !sessionId ||
    activeByEnvironment.has(environmentId) ||
    unresolvedByEnvironment.get(environmentId)?.has(sessionId)
  )
    return null;
  const token = Symbol("chatgpt-recovery-mutation");
  activeByEnvironment.set(environmentId, { token, sessionId, origin, action });
  let released = false;
  let yieldedSession: string | null = null;
  return {
    origin,
    action,
    sessionId,
    yieldToSession(pendingSessionId) {
      if (
        released ||
        !pendingSessionId ||
        yieldedSession ||
        activeByEnvironment.get(environmentId)?.token !== token ||
        unresolvedByEnvironment.get(environmentId)?.has(pendingSessionId)
      )
        return;
      const unresolved = unresolvedByEnvironment.get(environmentId) ?? new Map();
      unresolved.set(pendingSessionId, { token, sessionId: pendingSessionId, origin, action });
      unresolvedByEnvironment.set(environmentId, unresolved);
      yieldedSession = pendingSessionId;
      activeByEnvironment.delete(environmentId);
    },
    release() {
      if (released) return;
      released = true;
      if (activeByEnvironment.get(environmentId)?.token === token)
        activeByEnvironment.delete(environmentId);
      if (yieldedSession) {
        const unresolved = unresolvedByEnvironment.get(environmentId);
        if (unresolved?.get(yieldedSession)?.token === token) unresolved.delete(yieldedSession);
        if (unresolved?.size === 0) unresolvedByEnvironment.delete(environmentId);
      }
      // A scanner acquires/releases a passive lease for every inspection;
      // avoid recursively scheduling scans on those. Manual releases and
      // genuinely resolved deferred operations must wake recovery immediately.
      if ((origin === "manual" || yieldedSession) && typeof window !== "undefined")
        window.dispatchEvent(new CustomEvent("t3:chatgpt-recovery-mutation-settled", {
          detail: { environmentId, sessionId: yieldedSession ?? sessionId },
        }));
    },
  };
}

/** Metadata-only health gate. The actual mutation must still check exact guest/draft/send identity. */
/** Test isolation only: simulates replacing the entire renderer process. Never call from app flows. */
export function clearChatGPTRecoveryMutationGateForTests(): void {
  activeByEnvironment.clear();
  unresolvedByEnvironment.clear();
}

/** An unresolved host mutation must never be attempted again on the same guest. */
export function isChatGPTRecoveryMutationPending(
  environmentId: string,
  sessionId: string,
): boolean {
  return unresolvedByEnvironment.get(environmentId)?.has(sessionId) ?? false;
}

export function activeChatGPTRecoveryMutation(
  environmentId: string,
): Readonly<Pick<ActiveMutation, "sessionId" | "origin" | "action">> | null {
  const active = activeByEnvironment.get(environmentId);
  return active
    ? { sessionId: active.sessionId, origin: active.origin, action: active.action }
    : null;
}
