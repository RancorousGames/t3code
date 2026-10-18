/**
 * Reap only the disposable hello conversations created by five-hour provider
 * reset wakeups. Never delete a queued user job, an incomplete run, or a
 * thread that acquired additional user messages.
 *
 * The marker is the server-generated initial message ID, not a title alone.
 * Scanning the durable projections also covers wakeups created before a crash
 * or server restart; delete commands are idempotently identified per thread.
 */
import { CommandId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const WAKE_TITLE = "5-hour session wake";
const WAKE_PROMPT = "Say 'hello'.";
const CLEANUP_GRACE_MS = 30_000;
const SCAN_EVERY_MS = 15_000;

export function isDisposableProviderWake(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
  nowMs: number,
): boolean {
  if (
    projection.thread.title !== WAKE_TITLE ||
    projection.thread.creationSource !== "server" ||
    projection.thread.deletedAt !== null ||
    projection.thread.archivedAt !== null ||
    projection.runs.length !== 1
  )
    return false;
  const run = projection.runs[0];
  if (
    !run ||
    run.status !== "completed" ||
    run.completedAt === null ||
    DateTime.toEpochMillis(run.completedAt) > nowMs - CLEANUP_GRACE_MS
  )
    return false;
  const user = projection.messages.filter((m) => m.role === "user");
  const assistant = projection.messages.filter((m) => m.role === "assistant");
  if (user.length !== 1 || assistant.length === 0) return false;
  const sent = user[0]!;
  if (
    !String(sent.id).startsWith("reset-wake:") ||
    String(sent.id).includes(":test:") ||
    sent.text.trim() !== WAKE_PROMPT ||
    run.userMessageId !== sent.id
  )
    return false;
  // Every assistant message must belong to the only successfully completed
  // run, with no partial streaming text or unexpected system messages.
  if (projection.messages.some((m) => m.role === "system")) return false;
  return (
    assistant.every((m) => m.runId === run.id && !m.streaming) &&
    assistant.some((m) => m.text.trim().length > 0)
  );
}

export const makeCleanupSweep = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const nextScanAt = yield* Ref.make(0);
  return Effect.fn("ProviderResetWakeCleanupWorker.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs < (yield* Ref.get(nextScanAt))) return;
    yield* Ref.set(nextScanAt, nowMs + SCAN_EVERY_MS);
    const shells = yield* Effect.exit(threads.getShellSnapshot({ location: "active" }));
    if (shells._tag === "Failure") {
      yield* Effect.logWarning("Provider reset wake cleanup could not enumerate threads", {
        cause: shells.cause,
      });
      return;
    }
    // A title pre-filter is only a performance optimization. A title alone is
    // never proof of provenance or grounds for deletion.
    for (const shell of shells.value.threads) {
      if (shell.title !== WAKE_TITLE || shell.deletedAt !== null || shell.archivedAt !== null)
        continue;
      const detail = yield* Effect.exit(threads.getThreadProjection(shell.id));
      if (detail._tag === "Failure") continue;
      if (!isDisposableProviderWake(detail.value, nowMs)) continue;
      const removed = yield* Effect.exit(
        threads.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`reset-wake-cleanup:${shell.id}`),
          threadId: shell.id,
        }),
      );
      if (removed._tag === "Failure") {
        yield* Effect.logWarning("Provider reset wake cleanup delete failed", {
          threadId: shell.id,
          cause: removed.cause,
        });
      } else {
        yield* Effect.logInfo("Removed acknowledged five-hour provider reset hello thread", {
          threadId: shell.id,
        });
      }
    }
  });
});

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeCleanupSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("provider-reset-wake-cleanup", sweep());
  }),
);
