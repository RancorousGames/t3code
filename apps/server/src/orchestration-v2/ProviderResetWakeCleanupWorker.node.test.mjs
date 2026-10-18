import assert from "node:assert/strict";
import { test } from "node:test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { isDisposableProviderWake, makeCleanupSweep } from "./ProviderResetWakeCleanupWorker.ts";

const NOW = Date.parse("2026-10-15T20:00:00Z");
const completedAt = DateTime.fromDateUnsafe(new Date(NOW - 60000));
const fixture = () => ({
  thread: {
    title: "5-hour session wake",
    creationSource: "server",
    deletedAt: null,
    archivedAt: null,
  },
  runs: [
    { id: "run-1", userMessageId: "reset-wake:codex:reset", status: "completed", completedAt },
  ],
  messages: [
    {
      id: "reset-wake:codex:reset",
      role: "user",
      text: "Say 'hello'.",
      runId: "run-1",
      streaming: false,
    },
    { id: "answer", role: "assistant", text: "Hello!", runId: "run-1", streaming: false },
  ],
});
test("reaps only an acknowledged, completed, automation-owned hello thread", () => {
  assert.equal(isDisposableProviderWake(fixture(), NOW), true);
});
test("does not delete user jobs, manual threads or incomplete conversations", () => {
  const wake = fixture();
  const withChanges = [
    { ...wake, thread: { ...wake.thread, creationSource: "user" } },
    { ...wake, thread: { ...wake.thread, title: "My important project" } },
    {
      ...wake,
      messages: wake.messages.map((m) =>
        m.role === "user" ? { ...m, text: "Build my project" } : m,
      ),
    },
    {
      ...wake,
      messages: wake.messages.map((m) => (m.role === "user" ? { ...m, id: "manual-message" } : m)),
    },
    { ...wake, runs: wake.runs.map((r) => ({ ...r, status: "failed" })) },
    { ...wake, runs: wake.runs.map((r) => ({ ...r, status: "running" })) },
    { ...wake, messages: wake.messages.filter((m) => m.role === "user") },
    { ...wake, messages: [...wake.messages, { ...wake.messages[0], id: "followup" }] },
    { ...wake, runs: [...wake.runs, { ...wake.runs[0], id: "run-2" }] },
    { ...wake, thread: { ...wake.thread, archivedAt: completedAt } },
    {
      ...wake,
      runs: wake.runs.map((r) => ({ ...r, userMessageId: "reset-wake:codex:test:2026" })),
      messages: wake.messages.map((m) =>
        m.role === "user" ? { ...m, id: "reset-wake:codex:test:2026" } : m,
      ),
    },
    {
      ...wake,
      messages: wake.messages.map((m) => (m.role === "assistant" ? { ...m, streaming: true } : m)),
    },
  ];
  for (const p of withChanges) assert.equal(isDisposableProviderWake(p, NOW), false);
  assert.equal(isDisposableProviderWake(wake, NOW - 40000), false);
});

test("scheduled cleanup dispatches a single durable delete only for an eligible wake thread", async () => {
  const dispatched = [];
  const projection = fixture();
  const threads = ThreadManagement.ThreadManagementService.of({
    getShellSnapshot: () =>
      Effect.succeed({
        threads: [
          { id: "wake-thread-1", title: "5-hour session wake", deletedAt: null, archivedAt: null },
        ],
      }),
    getThreadProjection: () => Effect.succeed(projection),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return {};
      }),
  });
  const run = Effect.gen(function* () {
    const sweep = yield* makeCleanupSweep;
    yield* sweep();
    yield* sweep(); // scan throttling also prevents duplicate dispatches
  }).pipe(Effect.provideService(ThreadManagement.ThreadManagementService, threads));
  await Effect.runPromise(run);
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0], {
    type: "thread.delete",
    commandId: "reset-wake-cleanup:wake-thread-1",
    threadId: "wake-thread-1",
  });
});

test("scheduled cleanup leaves failed wake turns and user jobs untouched", async () => {
  for (const patch of [
    (p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, status: "failed" })) }),
    (p) => ({
      ...p,
      messages: p.messages.map((m) => (m.role === "user" ? { ...m, text: "Do the work!" } : m)),
    }),
  ]) {
    const dispatched = [];
    const projection = patch(fixture());
    const threads = ThreadManagement.ThreadManagementService.of({
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [
            {
              id: "wake-thread-1",
              title: "5-hour session wake",
              deletedAt: null,
              archivedAt: null,
            },
          ],
        }),
      getThreadProjection: () => Effect.succeed(projection),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return {};
        }),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const sweep = yield* makeCleanupSweep;
        yield* sweep();
      }).pipe(Effect.provideService(ThreadManagement.ThreadManagementService, threads)),
    );
    assert.equal(dispatched.length, 0);
  }
});
