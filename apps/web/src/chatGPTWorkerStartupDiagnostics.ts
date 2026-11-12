import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { chatGPTBrowserLastUrlKey, type BrowserSession } from "./chatGPTBrowserSessions";
import { chatGPTConversationIdFromUrl } from "./chatGPTConversationIdentity";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import type { SpawnReceipt } from "./chatGPTSpawnReceipts";

export const CHATGPT_WORKER_STARTUP_LOG_KEY = "t3code:chatgpt-worker-startup-log:v1";
const STARTUP_TIMEOUT_MS = 10 * 60_000;
const MAX_EVENTS = 2048;

type Stage = "created" | "delivery_started" | "delivery_finished" | "blank_worker" | "missing_bootstrap" | "registered";

type StartupEvent = {
  at: string;
  stage: Stage;
  environmentId: string;
  sessionId: string;
  requestId: string;
  taskRef: string | null;
  createdAt: number | null;
  delivery: "user_turn_observed" | "unknown" | "not_sent" | null;
  sendAttempted: boolean | null;
  conversationId: string | null;
  bootstrapState: string | null;
  reason: string | null;
};

/** Durable, bounded diagnostic timeline. Never log prompt bodies, draft contents or tokens. */
function persist(event: StartupEvent): void {
  try {
    const raw = window.localStorage.getItem(CHATGPT_WORKER_STARTUP_LOG_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return;
    if (
      (event.stage === "blank_worker" || event.stage === "missing_bootstrap" || event.stage === "registered") &&
      parsed.some((old) =>
        old && typeof old === "object" &&
        (old as StartupEvent).sessionId === event.sessionId &&
        (old as StartupEvent).stage === event.stage
      )
    ) return;
    window.localStorage.setItem(
      CHATGPT_WORKER_STARTUP_LOG_KEY,
      JSON.stringify([...parsed.slice(-(MAX_EVENTS - 1)), event]),
    );
    if (event.stage === "blank_worker" || event.stage === "missing_bootstrap" ||
      (event.stage === "delivery_finished" && event.delivery !== "user_turn_observed")) {
      console.warn("[ChatGPT worker startup]", event);
    }
  } catch (error) {
    console.warn("[ChatGPT worker startup] Could not persist startup diagnostics.", error);
  }
}

export function logChatGPTWorkerStartup(
  environmentId: EnvironmentId,
  session: BrowserSession,
  stage: Stage,
  receipt: SpawnReceipt | null,
  reason: string | null = null,
): void {
  if (session.binding?.role !== "worker" || !session.spawnRequestId) return;
  let conversationId: string | null = null;
  try {
    const url = getLocalStorageItem(
      chatGPTBrowserLastUrlKey(environmentId, session.id),
      Schema.String,
    );
    conversationId = chatGPTConversationIdFromUrl(url);
  } catch { /* A missing or corrupt cached URL must not suppress a startup diagnostic. */ }
  persist({
    at: new Date().toISOString(),
    stage,
    environmentId,
    sessionId: session.id,
    requestId: session.spawnRequestId,
    taskRef: session.binding.taskRef
      ? `${session.binding.taskRef.board} :: ${session.binding.taskRef.id}`
      : null,
    createdAt: session.createdAt ?? receipt?.createdAt ?? null,
    delivery: receipt?.initialDelivery?.delivery ?? null,
    sendAttempted: receipt?.initialDelivery?.sendAttempted ?? null,
    conversationId,
    bootstrapState: session.bootstrapIdentity?.state ?? null,
    reason: reason ?? receipt?.initialDelivery?.reason ?? null,
  });
}

/** Detect task-claimed workers that never formed a registered ChatGPT conversation. */
export function auditBlankChatGPTWorkers(
  environmentId: EnvironmentId,
  sessions: readonly BrowserSession[],
  receipts: readonly SpawnReceipt[],
  now: number,
): void {
  const bySession = new Map(receipts.map((r) => [r.sessionId, r]));
  for (const session of sessions) {
    if (session.binding?.role !== "worker" || !session.spawnRequestId || session.hidden) continue;
    const receipt = bySession.get(session.id) ?? null;
    if (session.bootstrapIdentity?.state === "registered") {
      logChatGPTWorkerStartup(environmentId, session, "registered", receipt);
      continue;
    }
    const createdAt = session.createdAt ?? receipt?.createdAt;
    if (!createdAt || now - createdAt < STARTUP_TIMEOUT_MS || createdAt > now) continue;
    let conversationId: string | null = null;
    try {
      conversationId = chatGPTConversationIdFromUrl(getLocalStorageItem(
        chatGPTBrowserLastUrlKey(environmentId, session.id), Schema.String,
      ));
    } catch { /* Cache corruption is itself consistent with an unbound guest. */ }
    logChatGPTWorkerStartup(
      environmentId, session, conversationId ? "missing_bootstrap" : "blank_worker",
      receipt, `No registered Bootstrap identity after ${Math.round((now - createdAt) / 60_000)} min.` +
        (receipt?.initialDelivery?.reason ? ` Delivery: ${receipt.initialDelivery.reason}` : ""),
    );
  }
}
