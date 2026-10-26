/**
 * In-renderer serialization for state-changing ChatGPT guest recovery operations.
 *
 * A manual action and a background recovery must never mutate the same browser
 * environment concurrently. This lease covers only operations, not passive
 * health reads. A rejected acquire never attempts the guest, mutates its draft,
 * or records a retry. A released token cannot revoke a newer reservation.
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

export interface RecoveryMutationLease {
  readonly origin: RecoveryMutationOrigin;
  readonly action: RecoveryMutationAction;
  readonly sessionId: string;
  release(): void;
}

/** Fail-closed, nonblocking reservation: the caller owns an exclusive slot only on success. */
export function tryAcquireChatGPTRecoveryMutation(
  environmentId: string,
  sessionId: string,
  origin: RecoveryMutationOrigin,
  action: RecoveryMutationAction,
): RecoveryMutationLease | null {
  if (!environmentId || !sessionId || activeByEnvironment.has(environmentId)) return null;
  const token = Symbol("chatgpt-recovery-mutation");
  activeByEnvironment.set(environmentId, { token, sessionId, origin, action });
  let released = false;
  return {
    origin,
    action,
    sessionId,
    release() {
      if (released) return;
      released = true;
      if (activeByEnvironment.get(environmentId)?.token === token)
        activeByEnvironment.delete(environmentId);
    },
  };
}

/** Metadata-only health gate. The actual mutation must still check exact guest/draft/send identity. */
/** Test isolation only: simulates replacing the entire renderer process. Never call from app flows. */
export function clearChatGPTRecoveryMutationGateForTests(): void {
  activeByEnvironment.clear();
}

export function activeChatGPTRecoveryMutation(
  environmentId: string,
): Readonly<Pick<ActiveMutation, "sessionId" | "origin" | "action">> | null {
  const active = activeByEnvironment.get(environmentId);
  return active
    ? { sessionId: active.sessionId, origin: active.origin, action: active.action }
    : null;
}
