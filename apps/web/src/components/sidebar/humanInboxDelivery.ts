import type { DesktopOpenRigSessionTarget } from "@t3tools/contracts";

export type HumanSendHold = {
  text: string;
  state: "preflight" | "retryable" | "sending" | "uncertain" | "route_changed";
  attemptId?: string;
  managedSessionId?: string;
  target?: DesktopOpenRigSessionTarget;
};

export const validHumanSendId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);

/** The marker makes read-only target-history reconciliation unambiguous. */
export function humanSendEnvelope(text: string, attemptId: string) {
  if (!validHumanSendId(attemptId)) throw new Error("Invalid outgoing message receipt.");
  return `[T3-HUMAN-DELIVERY:${attemptId}]\n${text}`;
}

export function sameHumanSendTarget(
  left: DesktopOpenRigSessionTarget | null | undefined,
  right: DesktopOpenRigSessionTarget | null | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "chatgpt-conversation" && right.kind === "chatgpt-conversation")
    return left.conversationId === right.conversationId;
  if (left.kind === "t3-thread" && right.kind === "t3-thread")
    return left.environmentId === right.environmentId && left.threadId === right.threadId;
  return false;
}

/** Only pre-POST failures are repeatable; UNKNOWN, including a lost IPC reply,
 * stays fenced until the exact message marker is observed in the destination. */
export function humanSendMayRetry(hold: HumanSendHold) {
  return hold.state === "retryable" && validHumanSendId(hold.attemptId);
}
