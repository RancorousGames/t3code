// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- fixed-origin desktop-only OpenRig capacity adapter.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const BASE = "http://127.0.0.1:7433/api/integrations/chatgpt-capacity-messages";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[0-9a-f]{12}$/i;
export type CapacityMessageRequest =
  | {
      action: "claim";
      messageId: string;
      sessionId: string;
      conversationId: string | null;
      maxActiveWorkers?: number;
    }
  | {
      action: "status" | "submit" | "uncertain" | "release";
      messageId: string;
      reason?: "assistant_idle_verified" | "pre_submit_aborted";
    };
export type CapacityMessageReceipt = {
  status: "admitted" | "waiting" | "held" | "submitted" | "uncertain" | "released" | "unavailable";
  reason?: string;
  messageId: string;
};
function bearer(): string | null {
  const configured =
    process.env.OPENRIG_TERMINAL_BEARER_TOKEN?.trim() ||
    process.env.OPENRIG_AUTH_BEARER_TOKEN?.trim();
  if (configured) return configured;
  try {
    const saved = NodeFS.readFileSync(
      NodePath.join(process.env.USERPROFILE || NodeOS.homedir(), ".openrig", "terminal-token"),
      "utf8",
    ).trim();
    return saved.length >= 24 ? saved : null;
  } catch {
    return null;
  }
}
/** No arbitrary URL or token from renderer; a lost POST receipt remains
 * UNKNOWN and must be reconciled via status, never replayed with a new ID. */
export async function requestCapacityMessage(
  input: CapacityMessageRequest,
): Promise<CapacityMessageReceipt> {
  if (!UUID.test(input.messageId)) throw new Error("Invalid capacity messageId");
  if (
    input.action === "claim" &&
    (!UUID.test(input.sessionId) ||
      (input.conversationId !== null && !UUID.test(input.conversationId)) ||
      (input.maxActiveWorkers !== undefined &&
        (!Number.isSafeInteger(input.maxActiveWorkers) ||
          input.maxActiveWorkers < 1 ||
          input.maxActiveWorkers > 100)))
  )
    throw new Error("Invalid capacity claim target");
  const path =
    input.action === "claim"
      ? "/claim"
      : `/${input.messageId}` +
        (input.action === "status"
          ? ""
          : "/" + (input.action === "release" ? "release" : input.action));
  const method = input.action === "status" ? "GET" : "POST";
  let response: Response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers: {
        Accept: "application/json",
        "content-type": "application/json",
        ...(bearer() ? { Authorization: `Bearer ${bearer()}` } : {}),
      },
      ...(method === "POST"
        ? {
            body: JSON.stringify(
              input.action === "claim"
                ? {
                    messageId: input.messageId,
                    sessionId: input.sessionId,
                    conversationId: input.conversationId,
                    ...(input.maxActiveWorkers ? { maxActiveWorkers: input.maxActiveWorkers } : {}),
                  }
                : input.action === "release"
                  ? { reason: input.reason }
                  : {},
            ),
          }
        : {}),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    return {
      status: "unavailable",
      reason: "OpenRig admission unavailable or outcome UNKNOWN; reconcile original ID.",
      messageId: input.messageId,
    };
  }
  if (!response.ok)
    return {
      status: "unavailable",
      reason: `OpenRig HTTP ${response.status}`,
      messageId: input.messageId,
    };
  const raw: unknown = await response.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { status: "unavailable", messageId: input.messageId };
  const data = raw as Record<string, unknown>;
  const lease =
    data.lease && typeof data.lease === "object" ? (data.lease as Record<string, unknown>) : null;
  if (lease && lease.messageId !== input.messageId)
    return { status: "unavailable", reason: "Lease identity mismatch", messageId: input.messageId };
  const state =
    typeof data.status === "string"
      ? data.status
      : typeof lease?.state === "string"
        ? lease.state
        : "unavailable";
  return {
    status:
      state === "reserved"
        ? "admitted"
        : state === "submitted"
          ? "submitted"
          : state === "uncertain"
            ? "uncertain"
            : state === "released"
              ? "released"
              : state === "admitted" || state === "waiting" || state === "held"
                ? state
                : "unavailable",
    ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
    messageId: input.messageId,
  };
}
