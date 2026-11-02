import type { AgentProviderV1SessionRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { agentProviderEpoch, dispatchBrowserCreate } from "./agentProviderBridge.ts";

export type CreateReceipt = {
  operationId: string;
  clientRequestId: string;
  state: "Created" | "NotCreated" | "Unknown";
  session: AgentProviderV1SessionRef | null;
  conversationId: string | null;
  initialPromptDelivery: "Delivered" | "Unknown" | "NotSent";
  parentConfirmed: boolean;
  observedAt: string;
  reason?: string;
};

const creations = new Map<string, { fingerprint: string; receipt: Promise<CreateReceipt>; operationId: string }>();
let next = 0;
const MAX_CREATES = 20_000;

export function hasBrowserCreateRequest(environmentId: string, requestId: string) {
  return creations.has(JSON.stringify([environmentId, requestId]));
}

export function getCreateReceipt(environmentId: string, requestId: string, operationId: string) {
  const entry = creations.get(JSON.stringify([environmentId, requestId]));
  return entry?.operationId === operationId ? entry.receipt : null;
}

export function startBrowserCreate(input: {
  environmentId: string;
  clientRequestId: string;
  title: string;
  initialMessage?: string;
  project?: string;
  parentSessionId?: string;
}): { kind: "new" | "duplicate"; receipt: Promise<CreateReceipt> } | { kind: "conflict" | "capacity" } {
  const key = JSON.stringify([input.environmentId, input.clientRequestId]);
  const fingerprint = JSON.stringify([input.title, input.initialMessage ?? "", input.project ?? "", input.parentSessionId ?? ""]);
  const existing = creations.get(key);
  if (existing) return existing.fingerprint === fingerprint
    ? { kind: "duplicate", receipt: existing.receipt }
    : { kind: "conflict" };
  if (creations.size >= MAX_CREATES) return { kind: "capacity" };
  const operationId = "browser-create:" + agentProviderEpoch + ":" + ++next;
  const receipt = (async (): Promise<CreateReceipt> => {
    const basic: CreateReceipt = {
      operationId, clientRequestId: input.clientRequestId, state: "Unknown",
      session: null, conversationId: null, initialPromptDelivery: "Unknown",
      parentConfirmed: false, observedAt: DateTime.formatIso(Effect.runSync(DateTime.now)),
    };
    try {
      const result = await dispatchBrowserCreate(input.environmentId, {
        clientRequestId: input.clientRequestId,
        title: input.title,
        ...(input.initialMessage !== undefined ? { prompt: input.initialMessage } : {}),
        ...(input.project ? { project: input.project } : {}),
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      });
      if (result === null) return { ...basic, reason: "Desktop result missing; never retry automatically." };
      if (!result.ok) return {
        ...basic, state: result.code === "Unavailable" ? "Unknown" : "NotCreated",
        reason: result.message,
      };
      const data = result.data as {
        created?: boolean; unknown?: boolean; sessionId?: string; conversationId?: string | null;
        promptDelivery?: string; parentConfirmed?: boolean; reason?: string;
      };
      if (data?.unknown)
        return { ...basic, reason: data.reason ?? "Browser creation uncertainty; do not retry." };
      if (!data?.created || !data.sessionId)
        return { ...basic, state: "NotCreated", reason: data?.reason ?? "Desktop did not create a session." };
      return {
        ...basic, state: "Created", session: { provider: "t3", id: data.sessionId },
        conversationId: data.conversationId ?? null,
        initialPromptDelivery: data.promptDelivery === "user_turn_observed" && data.conversationId
          ? "Delivered" : data.promptDelivery === "not_sent" ? "NotSent" : "Unknown",
        parentConfirmed: data.parentConfirmed === true,
        ...(data.reason ? { reason: data.reason } : {}),
      };
    } catch {
      return { ...basic, reason: "Desktop create response uncertain; reconcile exact request before trying again." };
    }
  })();
  creations.set(key, { fingerprint, receipt, operationId });
  return { kind: "new", receipt };
}
