import type { EnvironmentId } from "@t3tools/contracts";
import { randomUUID } from "./lib/utils";
import { wakeChatGPTBrowserSession } from "./chatGPTBrowserSessions";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type { BrowserSession } from "./chatGPTBrowserSessions";
import {
  readChatGPTIdleTransition,
  subscribeChatGPTIdleTransitions,
  type ChatGPTIdleTransition,
} from "./chatGPTIdleTransitions";
import {
  hasUncertainChatGPTSend,
  inspectBrowserSession,
  runChatGPTSessionControl,
} from "./chatGPTSessionControl";

// The Session cockpit is an overlay and may unmount while ChatGPT keeps working.
// Keep messages in the renderer's durable session store, and dispatch from the
// permanently mounted browser-session runtime instead of the composer component.
export type SessionQueuedMessage = {
  id: string;
  text: string;
  conversationId: string | null;
  /** An optional admission rule; absent means legacy send-when-idle. */
  condition?: "when_idle" | "wait_for_slot";
  maxActiveWorkers?: number;
  capacityReleasedAt?: number;
  capacityAdmittedAt?: number;
  /** Earliest possible submission time, before interacting with the guest. */
  capacitySubmittedAt?: number;
  state: "queued" | "sending" | "delivered" | "unknown" | "needs_attention";
  createdAt: number;
  updatedAt: number;
  detail?: string;
};

const eventName = "t3:chatgpt-session-queue-change";
const keyFor = (environmentId: EnvironmentId, sessionId: string) =>
  `t3code:chatgpt-browser:session-queue:v1:${environmentId}:${sessionId}`;
const empty = "[]";
const processing = new Set<string>();
const capacityReleases = new Set<string>();

function readRaw(key: string) {
  try {
    return localStorage.getItem(key) ?? empty;
  } catch {
    return empty;
  }
}

function readQueue(key: string): SessionQueuedMessage[] {
  try {
    const value: unknown = JSON.parse(readRaw(key));
    const queue = Array.isArray(value)
      ? value.filter(
          (item): item is SessionQueuedMessage =>
            !!item &&
            typeof item === "object" &&
            typeof item.id === "string" &&
            typeof item.text === "string" &&
            ["queued", "sending", "delivered", "unknown", "needs_attention"].includes(item.state),
        )
      : [];
    if (!processing.has(key) && queue.some((item) => item.state === "sending")) {
      // A renderer reload left an ambiguous in-flight send. No second click.
      const recovered = queue.map((item) =>
        item.state === "sending"
          ? {
              ...item,
              state: "unknown" as const,
              detail: "The sender reloaded; inspect Browser before retrying.",
            }
          : item,
      );
      writeQueue(key, recovered);
      return recovered;
    }
    return queue;
  } catch {
    return [];
  }
}

function writeQueue(key: string, queue: SessionQueuedMessage[]) {
  // Retain the complete unresolved FIFO and a few recent positive receipts.
  // Never prune an acknowledged user turn while its global worker slot is
  // still leased; it needs one future verified idle event to release capacity.
  const settled = queue.filter(item=>item.state==="delivered" &&
    item.condition==="wait_for_slot" && !item.capacityReleasedAt).concat(
    queue.filter(item=>item.state==="delivered" &&
      (item.condition!=="wait_for_slot" || !!item.capacityReleasedAt)).slice(-8));
  const pending = queue.filter((item) => item.state !== "delivered");
  localStorage.setItem(
    key,
    JSON.stringify([...settled, ...pending].sort((a, b) => a.createdAt - b.createdAt)),
  );
  window.dispatchEvent(new CustomEvent(eventName, { detail: key }));
}

export function queueChatGPTSessionMessage(
  environmentId: EnvironmentId,
  sessionId: string,
  text: string,
  conversationId: string | null,
  stableMessageId?: string,
  options?: { condition?: "when_idle" | "wait_for_slot"; maxActiveWorkers?: number },
) {
  const key = keyFor(environmentId, sessionId);
  const body = text.trim();
  if (!body || body.length > 29_800)
    throw new Error("A message must be between 1 and 29,800 characters.");
  if (stableMessageId && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stableMessageId))
    throw new Error("A stable queue ID must be a UUID.");
  if (
    options?.condition === "wait_for_slot" &&
    options.maxActiveWorkers !== undefined &&
    (!Number.isSafeInteger(options.maxActiveWorkers) ||
      options.maxActiveWorkers < 1 ||
      options.maxActiveWorkers > 100)
  )
    throw new Error("Max active workers must be 1–100.");
  const id = stableMessageId ?? randomUUID();
  const queue = readQueue(key);
  const previous = queue.find((row) => row.id === id);
  if (previous) {
    if (
      previous.text !== body ||
      previous.conversationId !== conversationId ||
      (previous.condition ?? "when_idle") !== (options?.condition ?? "when_idle") ||
      (previous.maxActiveWorkers ?? null) !== (options?.maxActiveWorkers ?? null)
    )
      throw new Error("Stable queued message ID conflicts with an existing message.");
    return id; // An UNKNOWN queue/write receipt cannot submit a second answer.
  }
  const time = Date.now();
  writeQueue(key, [
    ...queue,
    {
      id,
      text: body,
      conversationId,
      ...(options?.condition ? { condition: options.condition } : {}),
      ...(options?.maxActiveWorkers ? { maxActiveWorkers: options.maxActiveWorkers } : {}),
      state: "queued",
      createdAt: time,
      updatedAt: time,
    },
  ]);
  // Do not wake a blank/new guest until OpenRig actually admits its slot.
  if (options?.condition !== "wait_for_slot") wakeChatGPTBrowserSession(environmentId, sessionId);
  return id;
}

/** Remove an undelivered message only while no submission can have started. */
export function cancelChatGPTSessionQueuedMessage(
  environmentId: EnvironmentId,
  sessionId: string,
  messageId: string,
) {
  const key = keyFor(environmentId, sessionId);
  const queue = readQueue(key);
  const item = queue.find((row) => row.id === messageId);
  if (!item || (item.state !== "queued" && item.state !== "needs_attention")) return false;
  if (item.condition === "wait_for_slot" && item.capacityAdmittedAt) {
    if (item.state === "needs_attention") return false; // May have submitted; reconcile first.
    const release=window.desktopBridge?.chatGPTCapacityMessage;
    if (!release) return false;
    void release({action:"release",messageId:item.id,reason:"pre_submit_aborted"})
      .then(receipt=>{
        if(receipt.status!=="released") return;
        if(readQueue(key).find(row=>row.id===messageId)?.state==="queued")
          writeQueue(key,readQueue(key).filter(row=>row.id!==messageId));
      });
    return true; // Cancellation requested; receipt determines actual removal.
  }
  writeQueue(key, queue.filter((row) => row.id !== messageId));
  return true;
}

export function useChatGPTSessionQueue(environmentId: EnvironmentId, sessionId: string) {
  const key = keyFor(environmentId, sessionId);
  const raw = useSyncExternalStore(
    (listener) => {
      const local = (event: Event) => {
        if ((event as CustomEvent<string>).detail === key) listener();
      };
      const crossWindow = (event: StorageEvent) => {
        if (event.key === key) listener();
      };
      window.addEventListener(eventName, local);
      window.addEventListener("storage", crossWindow);
      return () => {
        window.removeEventListener(eventName, local);
        window.removeEventListener("storage", crossWindow);
      };
    },
    () => readRaw(key),
    () => empty,
  );
  return useMemo(() => {
    try {
      return JSON.parse(raw) as SessionQueuedMessage[];
    } catch {
      return [];
    }
  }, [raw]);
}

// A refused pre-submit inspection is safe to retry: no composer action occurred.
// Once a send starts, any ambiguous error is UNKNOWN, never automatically re-clicked.
const definitelyNotSubmitted = (reason: string) =>
  /New-chat target changed before typing; no message sent|ChatGPT guest is not attached|ChatGPT page is unavailable before typing; no message sent|Preview tab has not attached|Browser page is loading|Embedded ChatGPT webview is not mounted|Session is hidden|Composer contains an existing draft; refusing to overwrite it|Session URL, generation or guest changed before typing; refusing send|Queued attempt expired before dispatch; no message sent/i.test(
    reason,
  );

export async function deliverNextChatGPTSessionMessage(
  environmentId: EnvironmentId,
  sessionId: string,
  sessions: readonly BrowserSession[],
) {
  const key = keyFor(environmentId, sessionId);
  if (processing.has(key)) return;
  let queue = readQueue(key);
  // A prior in-flight send may have lost its JavaScript promise on page reload.
  // Treat it as UNKNOWN; a fresh renderer must never issue a second click.
  if (
    queue.some(
      (row) =>
        row.state === "sending" || row.state === "unknown" || row.state === "needs_attention",
    )
  )
    return;
  const next = queue.find((row) => row.state === "queued");
  if (!next) return;
  const session = sessions.find((row) => row.id === sessionId);
  if (!session || session.hidden) return;
  processing.add(key);
  try {
    // Admit capacity BEFORE inspecting/loading the ChatGPT guest. Otherwise
    // a new or suspended session could never become idle enough to qualify.
    if (next.condition === "wait_for_slot") {
      const capacity = window.desktopBridge?.chatGPTCapacityMessage;
      if (!capacity) return;
      let result = await capacity({action:"status",messageId:next.id});
      if (result.status === "unavailable") result = await capacity({
        action:"claim",messageId:next.id,sessionId,
        conversationId:next.conversationId,
        ...(next.maxActiveWorkers ? {maxActiveWorkers:next.maxActiveWorkers} : {}),
      });
      if (result.status !== "admitted") return;
      if (readQueue(key).find(row=>row.id===next.id)?.state!=="queued") {
        void capacity({action:"release",messageId:next.id,reason:"pre_submit_aborted"});
        return;
      }
      if (!next.capacityAdmittedAt) {
        writeQueue(key,readQueue(key).map(row=>row.id===next.id ? {
          ...row, capacityAdmittedAt: Date.now(),
        } : row));
        window.dispatchEvent(new CustomEvent("t3:chatgpt-capacity-admitted",{
          detail:{environmentId,sessionId,messageId:next.id},
        }));
      }
    }
    // An existing interrupted/UNKNOWN injection owns this guest. Preserve FIFO
    // without generating another send until that delivery is reconciled.
    if (hasUncertainChatGPTSend(environmentId, sessionId)) return;
    const observed = await inspectBrowserSession(environmentId, session, "end", 1);
    const idle =
      observed.activity === "idle" &&
      ["new", "done_or_idle", "waiting_for_input"].includes(observed.status);
    if (!idle) return;
    // An unknown initial home page may only deliver into a *new* chat.
    // Never silently retarget a queued message if the guest navigated.
    if (next.conversationId) {
      if (observed.conversationId !== next.conversationId) {
        if (observed.conversationId && observed.conversationId !== next.conversationId) {
          writeQueue(
            key,
            readQueue(key).map((row) =>
              row.id === next.id
                ? {
                    ...row,
                    state: "needs_attention" as const,
                    updatedAt: Date.now(),
                    detail:
                      "Conversation changed before queued delivery. The message was not sent.",
                  }
                : row,
            ),
          );
        }
        return;
      }
    } else if (observed.status !== "new" || observed.conversationId) {
      queue = readQueue(key).map((row) =>
        row.id === next.id
          ? {
              ...row,
              state: "needs_attention" as const,
              updatedAt: Date.now(),
              detail: "The new-chat page changed before delivery. Review the target in Browser.",
            }
          : row,
      );
      writeQueue(key, queue);
      return;
    }
    // Capacity is a delivery condition, not another work queue. T3 keeps
    // the original stable message ID until OpenRig atomically admits it.
    if (next.condition === "wait_for_slot") {
      const request = window.desktopBridge?.chatGPTCapacityMessage;
      if (!request) return; // No local OpenRig: never silently bypass the ceiling.
      let claim = await request({ action: "status", messageId: next.id });
      if (claim.status === "unavailable") {
        claim = await request({
          action: "claim",
          messageId: next.id,
          sessionId,
          conversationId: next.conversationId,
          ...(next.maxActiveWorkers ? { maxActiveWorkers: next.maxActiveWorkers } : {}),
        });
      }
      if (claim.status !== "admitted") return;
      if (readQueue(key).find((row) => row.id === next.id)?.state !== "queued") {
        await request({ action: "release", messageId: next.id, reason: "pre_submit_aborted" });
        return;
      }
      // Fence user cancellation before reserving the possible browser send.
      writeQueue(
        key,
        readQueue(key).map((row) =>
          row.id === next.id
            ? {
                ...row,
                state: "sending" as const,
                updatedAt: Date.now(),
              }
            : row,
        ),
      );
      const accepted = await request({ action: "submit", messageId: next.id });
      // A lost submit acknowledgement may mean the reservation was consumed.
      // No browser submission without an exact positive receipt.
      if (accepted.status !== "submitted") {
        writeQueue(
          key,
          readQueue(key).map((row) =>
            row.id === next.id
              ? {
                  ...row,
                  state: "needs_attention" as const,
                  updatedAt: Date.now(),
                  detail:
                    "Capacity submit receipt unknown. Inspect original OpenRig reservation before retrying.",
                }
              : row,
          ),
        );
        return;
      }
      writeQueue(key, readQueue(key).map((row) =>
        row.id === next.id ? { ...row, capacitySubmittedAt: Date.now() } : row,
      ));
    }
    // Re-read to avoid racing an unrelated user edit/reordered queue.
    if (
      readQueue(key).find((row) => row.id === next.id)?.state !==
      (next.condition === "wait_for_slot" ? "sending" : "queued")
    )
      return;
    writeQueue(
      key,
      readQueue(key).map((row) =>
        row.id === next.id ? { ...row, state: "sending" as const, updatedAt: Date.now() } : row,
      ),
    );
    try {
      const result = await runChatGPTSessionControl({
        environmentId,
        sessions,
        action: "send",
        sessionId,
        message: `[T3-MSG:${next.id}]\n${next.text}`,
        ...(next.conversationId
          ? { expectedConversationId: next.conversationId }
          : { expectedNewChat: true }),
      });
      const receipt = result as { delivery?: string; messageSent?: boolean } | null;
      const state =
        receipt?.delivery === "user_turn_observed" && receipt.messageSent === true
          ? "delivered"
          : "unknown";
      writeQueue(
        key,
        readQueue(key).map((row) =>
          row.id === next.id
            ? {
                ...row,
                state,
                updatedAt: Date.now(),
                ...(state === "unknown"
                  ? { detail: "Delivery was not confirmed; inspect Browser before retrying." }
                  : {}),
              }
            : row,
        ),
      );
    } catch (error) {
      const detail = String(error);
      // A consumed capacity reservation is never silently re-armed after
      // any unconfirmed browser result. Reconcile the original lease first.
      const state = next.condition === "wait_for_slot" ? "needs_attention" :
        definitelyNotSubmitted(detail) ? "queued" : "unknown";
      writeQueue(
        key,
        readQueue(key).map((row) =>
          row.id === next.id ? { ...row, state, updatedAt: Date.now(), detail } : row,
        ),
      );
    }
  } catch {
    // Not ready yet. Preserve the exact queue item and capacity reservation.
  } finally {
    processing.delete(key);
  }
}

/** A browser user-turn receipt does not itself free a worker slot. */
export function shouldReleaseCapacityAfterIdle(
  item: SessionQueuedMessage,
  transition: ChatGPTIdleTransition,
): boolean {
  return item.condition === "wait_for_slot" &&
    item.state === "delivered" &&
    !item.capacityReleasedAt &&
    !!item.capacitySubmittedAt &&
    transition.observedAt >= item.capacitySubmittedAt &&
    (item.conversationId === null || transition.conversationId === item.conversationId);
}

/** The completed assistant turn must be proven by a T3 idle transition,
 * and OpenRig independently validates current idle before releasing. */
function releaseDeliveredCapacity(
  environmentId: EnvironmentId,
  sessionId: string,
  transition: ChatGPTIdleTransition | null = readChatGPTIdleTransition(environmentId, sessionId),
) {
  const callback = window.desktopBridge?.chatGPTCapacityMessage;
  if (!callback || !transition || transition.environmentId !== environmentId ||
      transition.sessionId !== sessionId) return;
  const key = keyFor(environmentId, sessionId);
  for (const item of readQueue(key)) {
    // A delivered user turn is NOT a completed assistant turn. Only a proven
    // post-submit busy→idle transition of the exact conversation frees a slot.
    if (!shouldReleaseCapacityAfterIdle(item, transition) || capacityReleases.has(item.id))
      continue;
    capacityReleases.add(item.id);
    void callback({ action: "release", messageId: item.id, reason: "assistant_idle_verified" })
      .then((receipt) => {
        if (receipt.status !== "released") return;
        writeQueue(
          key,
          readQueue(key).map((row) =>
            row.id === item.id
              ? {
                  ...row,
                  capacityReleasedAt: Date.now(),
                }
              : row,
          ),
        );
      })
      .catch(() => {})
      .finally(() => capacityReleases.delete(item.id));
  }
}

/** Capacity admission is durable so a resumed renderer can mount the
 * exact guest before attempting its first queued prompt. */
export function hasAdmittedCapacityMessage(environmentId:EnvironmentId,sessionId:string) {
  return readQueue(keyFor(environmentId,sessionId)).some(row=>
    row.condition==="wait_for_slot" && !!row.capacityAdmittedAt &&
    !row.capacityReleasedAt && ["queued","sending","delivered"].includes(row.state));
}

/** Called by the mounted session runtime even when its Session overlay is hidden. */
export function useChatGPTSessionQueueDriver(
  environmentId: EnvironmentId,
  sessionId: string,
  sessions: readonly BrowserSession[],
) {
  const queue = useChatGPTSessionQueue(environmentId, sessionId);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const pending = queue.some(
    (row) =>
      row.state === "queued" ||
      (row.condition === "wait_for_slot" && row.state === "delivered" && !row.capacityReleasedAt),
  );
  useEffect(() => {
    if (!pending) return;
    const drain = () =>
      void deliverNextChatGPTSessionMessage(environmentId, sessionId, sessionsRef.current);
    // A queued message gets an immediate chance on mount or registration. If
    // busy, wait for T3's verified idle event rather than polling every 2.5s.
    drain();
    releaseDeliveredCapacity(environmentId, sessionId);
    const unsubscribeIdle = subscribeChatGPTIdleTransitions((event) => {
      if (event.environmentId !== environmentId) return;
      if (event.sessionId === sessionId) {
        // Consume only this exact post-submit verified idle transition.
        releaseDeliveredCapacity(environmentId, sessionId, event);
      }
      // A slot becoming free elsewhere is also a legitimate admission trigger.
      // OpenRig arbitrates concurrent claims; no renderer capacity count.
      if (
        event.sessionId === sessionId ||
        queue.some((item) => item.state === "queued" && item.condition === "wait_for_slot")
      )
        drain();
    });
    // A browser guest may have been unavailable at mount time, then attach
    // already idle after restart. Reuse its existing lifecycle notification.
    const onRecovery = (event: Event) => {
      const detail = (event as CustomEvent<{ environmentId: string; sessionId: string }>).detail;
      if (detail?.environmentId === environmentId && detail.sessionId === sessionId) {
        drain();
        releaseDeliveredCapacity(environmentId, sessionId);
      }
    };
    window.addEventListener("t3:chatgpt-recovery-state-changed", onRecovery);
    // Other OpenRig workers can release capacity without emitting a local T3
    // idle event. Retry admission only while a Wait-for-slot item is pending;
    // this does not poll ChatGPT or schedule a Caffy wake.
    const admissionRetry = queue.some((row) => row.state === "queued" &&
      row.condition === "wait_for_slot") ? window.setInterval(drain, 5_000) : null;
    return () => {
      unsubscribeIdle();
      if (admissionRetry !== null) window.clearInterval(admissionRetry);
      window.removeEventListener("t3:chatgpt-recovery-state-changed", onRecovery);
    };
  }, [environmentId, sessionId, pending, sessionsRef]);
}
