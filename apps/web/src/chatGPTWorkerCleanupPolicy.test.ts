import { describe, expect, it } from "vite-plus/test";
import type { BrowserSession } from "./chatGPTBrowserSessions";
import {
  DEFAULT_WORKER_CLEANUP_SETTINGS,
  planChatGPTWorkerCleanup,
  recordWorkerCleanupIntent,
  reconcileWorkerCleanupLedger,
  type WorkerCleanupInput,
} from "./chatGPTWorkerCleanupPolicy";

describe("T3 completed child cleanup (dry by default)", () => {
  const url = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const now = Date.parse("2026-10-23T13:30:00Z");
  const declaredAt = "2026-10-23T12:00:00Z";
  const completion = { declaredAt, observedUrl: url, observedTurns: 4 };
  const manager: BrowserSession = { id: "manager", title: "Manager" };
  const worker: BrowserSession = {
    id: "worker",
    title: "Worker",
    parentSessionId: "manager",
    completion,
  };
  const link = { sessionId: "worker", parentSessionId: "manager", spawnRequestId: "spawn-1" };
  const inspection = {
    sessionId: "worker",
    observedAtMs: now - 1000,
    idleSinceMs: now - 20 * 60_000,
    hidden: false,
    status: "done_or_idle",
    activity: "idle",
    uiColor: "idle",
    observedGuestUrl: url,
    totalTurns: 4,
    completion,
    composer: "empty" as const,
    send: "clear" as const,
    recovery: "clear" as const,
  };
  const settings = {
    ...DEFAULT_WORKER_CLEANUP_SETTINGS,
    enabled: true,
    enabledAtMs: Date.parse("2026-10-23T11:00:00Z"),
  };
  const input: WorkerCleanupInput = {
    sessions: [manager, worker],
    links: [link],
    spawnReceipts: [{ sessionId: "worker", requestId: "spawn-1" }],
    doneReceipts: [{ sessionId: "worker", declaredAt, source: "verified_worker_done" }],
    inspections: [inspection],
    ledger: [],
    settings,
    nowMs: now,
    mode: "execute",
    startupReconciled: true,
  };

  it("permits only an explicitly verified, completed, quiescent child after grace", () => {
    const plan = planChatGPTWorkerCleanup(input);
    expect(plan.actions).toEqual([{ sessionId: "worker", action: "archive" }]);
    expect(plan.preview).toEqual([
      {
        sessionId: "worker",
        proposedAction: "archive",
        reasons: [],
      },
    ]);
  });

  it("is opt-in, dry-run, and cold-start inert even with eligible workers", () => {
    expect(
      planChatGPTWorkerCleanup({ ...input, settings: DEFAULT_WORKER_CLEANUP_SETTINGS }).actions,
    ).toEqual([]);
    expect(planChatGPTWorkerCleanup({ ...input, mode: "preview" }).actions).toEqual([]);
    expect(planChatGPTWorkerCleanup({ ...input, startupReconciled: false }).actions).toEqual([]);
    // No sweep of sessions declared completed before the user opted in.
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        settings: { ...settings, enabledAtMs: now - 1000 },
      }).actions,
    ).toEqual([]);
  });

  it("never infers provenance from session titles, project, idle or a loose parent link", () => {
    expect(planChatGPTWorkerCleanup({ ...input, links: [] }).actions).toEqual([]);
    expect(planChatGPTWorkerCleanup({ ...input, spawnReceipts: [] }).actions).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        links: [{ ...link, parentSessionId: "stranger" }],
      }).actions,
    ).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        sessions: [worker],
      }).actions,
    ).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        sessions: [manager, { ...worker, parentSessionId: null }],
      }).actions,
    ).toEqual([]);
    // Someone else reopening/renaming a tab does not manufacture lineage.
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        sessions: [manager, { ...worker, parentSessionId: "manager", project: "Any" }],
        links: [],
      }).actions,
    ).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        sessions: [manager, { ...worker, parentSessionId: "worker" }],
        links: [{ ...link, parentSessionId: "worker" }],
      }).actions,
    ).toEqual([]);
  });

  it("never treats released task claims or a bare completion marker as verified owner completion", () => {
    expect(planChatGPTWorkerCleanup({ ...input, doneReceipts: [] }).actions).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        doneReceipts: [
          {
            sessionId: "worker",
            declaredAt: "2026-10-23T12:01:00Z",
            source: "verified_worker_done",
          },
        ],
      }).actions,
    ).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        sessions: [manager, { ...worker, completion: undefined }],
      }).actions,
    ).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        inspections: [{ ...inspection, completion: null }],
      }).actions,
    ).toEqual([]);
  });

  it("rejects pending, stuck, interrupted, recovering, unfinished, and nonempty drafts", () => {
    for (const status of [
      "working",
      "pending_or_stalled",
      "stuck",
      "stuck_connecting",
      "waiting_for_input",
      "loading",
      "unavailable",
      "hibernated",
    ]) {
      expect(
        planChatGPTWorkerCleanup({
          ...input,
          inspections: [{ ...inspection, status }],
        }).actions,
      ).toEqual([]);
    }
    for (const override of [
      { activity: "working" },
      { uiColor: "interrupted" },
      { uiColor: "delivery-timeout" },
      { uiColor: "unknown" },
      { send: "unresolved" },
      { send: "unknown" },
      { composer: "nonempty" },
      { composer: "unknown" },
      { recovery: "recovering" },
      { recovery: "interrupted" },
      { recovery: "unknown" },
      { idleSinceMs: null },
      { idleSinceMs: now - 60_000 },
      { observedAtMs: now - 60_000 },
      { observedGuestUrl: "https://chatgpt.com/c/cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee" },
      { observedGuestUrl: null },
      { totalTurns: 5 },
      { hidden: true },
    ] as const) {
      expect(
        planChatGPTWorkerCleanup({
          ...input,
          inspections: [{ ...inspection, ...override }],
        }).actions,
      ).toEqual([]);
    }
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        settings: { ...settings, archiveGraceMs: 1000 },
      }).actions,
    ).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        nowMs: Date.parse("2026-10-23T12:30:00Z"),
      }).actions,
    ).toEqual([]);
  });

  it("does not abandon descendants, including nested/archived/unknown children", () => {
    const grandchild: BrowserSession = {
      id: "grandchild",
      title: "Grandchild",
      parentSessionId: "worker",
      hidden: true,
    };
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        sessions: [manager, worker, grandchild],
      }).actions,
    ).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        sessions: [
          manager,
          worker,
          { id: "a", title: "A", parentSessionId: "worker" },
          { id: "b", title: "B", parentSessionId: "a" },
        ],
      }).actions,
    ).toEqual([]);
  });

  it("records an intent BEFORE side effects; restart reconciliation never retries unknown results", () => {
    const intent = recordWorkerCleanupIntent([], worker, "archive", link, now);
    expect(intent[0]?.phase).toBe("archive_pending");
    expect(planChatGPTWorkerCleanup({ ...input, ledger: intent }).actions).toEqual([]);
    expect(() => recordWorkerCleanupIntent(intent, worker, "archive", link, now)).toThrow(
      /Previous intent/,
    );
    expect(reconcileWorkerCleanupLedger(intent, input.sessions, new Set(), now)).toEqual(intent);

    const archivedAt = new Date(now).toISOString();
    const archivedWorker: BrowserSession = {
      ...worker,
      hidden: true,
      archive: {
        archivedAt,
        conversationUrl: url,
        basis: "completion",
      },
    };
    // Persisted hidden bit alone is not evidence that the preview was released.
    expect(reconcileWorkerCleanupLedger(intent, [manager, archivedWorker], new Set(), now)).toEqual(
      intent,
    );
    const archived = reconcileWorkerCleanupLedger(
      intent,
      [manager, archivedWorker],
      new Set(["worker"]),
      now,
    );
    expect(archived[0]?.phase).toBe("archived");
    expect(
      reconcileWorkerCleanupLedger(archived, [manager, archivedWorker], new Set(["worker"]), now),
    ).toEqual(archived);
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        sessions: [manager, archivedWorker],
        ledger: archived,
        nowMs: now + 1000,
      }).actions,
    ).toEqual([]);

    // A restored archive is not automatically swept again.
    expect(
      planChatGPTWorkerCleanup({
        ...input,
        sessions: [
          manager,
          {
            ...archivedWorker,
            hidden: false,
            archive: { ...archivedWorker.archive!, restoredAt: new Date(now + 2000).toISOString() },
          },
        ],
        ledger: archived,
      }).actions,
    ).toEqual([]);
  });

  it("only offers optional close after a week of confirmed archived state, preserving a ledger URL", () => {
    const archivedAt = "2026-10-14T13:30:00Z";
    const oldDeclaredAt = "2026-10-14T12:00:00Z";
    const oldWorker: BrowserSession = {
      ...worker,
      completion: { ...completion, declaredAt: oldDeclaredAt },
    };
    const archivedWorker: BrowserSession = {
      ...oldWorker,
      hidden: true,
      archive: {
        archivedAt,
        conversationUrl: url,
        basis: "completion",
      },
    };
    const archived = [
      {
        sessionId: "worker",
        parentSessionId: "manager",
        spawnRequestId: "spawn-1",
        declaredAt: oldDeclaredAt,
        conversationUrl: url,
        archivedAt,
        phase: "archived" as const,
        updatedAtMs: now,
      },
    ];
    const closeInput: WorkerCleanupInput = {
      ...input,
      sessions: [manager, archivedWorker],
      ledger: archived,
      doneReceipts: [
        { sessionId: "worker", declaredAt: oldDeclaredAt, source: "verified_worker_done" },
      ],
      settings: {
        ...settings,
        enabledAtMs: Date.parse("2026-10-01T12:00:00Z"),
        closeEnabled: true,
      },
    };
    expect(planChatGPTWorkerCleanup(closeInput).actions).toEqual([
      { sessionId: "worker", action: "close" },
    ]);
    expect(
      planChatGPTWorkerCleanup({
        ...closeInput,
        settings: { ...closeInput.settings, closeEnabled: false },
      }).actions,
    ).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...closeInput,
        sessions: [
          manager,
          {
            ...archivedWorker,
            archive: {
              ...archivedWorker.archive!,
              basis: "manager_decision",
            },
          },
        ],
      }).actions,
    ).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...closeInput,
        sessions: [
          manager,
          {
            ...archivedWorker,
            archive: {
              ...archivedWorker.archive!,
              restoredAt: "2026-10-22T12:00:00Z",
            },
          },
        ],
      }).actions,
    ).toEqual([]);
    expect(
      planChatGPTWorkerCleanup({
        ...closeInput,
        sessions: [
          manager,
          archivedWorker,
          {
            id: "child",
            title: "Child",
            parentSessionId: "worker",
          },
        ],
      }).actions,
    ).toEqual([]);

    const pendingClose = recordWorkerCleanupIntent(archived, archivedWorker, "close", link, now);
    expect(pendingClose[0]?.phase).toBe("close_pending");
    expect(planChatGPTWorkerCleanup({ ...closeInput, ledger: pendingClose }).actions).toEqual([]);
    expect(reconcileWorkerCleanupLedger(pendingClose, [manager], new Set(), now)).toEqual(
      pendingClose,
    );
    const closed = reconcileWorkerCleanupLedger(pendingClose, [manager], new Set(["worker"]), now);
    expect(closed[0]).toMatchObject({ phase: "closed", conversationUrl: url, archivedAt });
    expect(reconcileWorkerCleanupLedger(closed, [manager], new Set(["worker"]), now)).toEqual(
      closed,
    );
  });
});
