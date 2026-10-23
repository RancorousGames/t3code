import { describe, expect, it } from "vite-plus/test";

import type { BrowserSession } from "../../chatGPTBrowserSessions";
import {
  DEFAULT_WORKER_CLEANUP_SETTINGS,
  planChatGPTWorkerCleanup,
} from "../../chatGPTWorkerCleanupPolicy";
import { previewUnverifiedWorkerCleanup } from "./chatGPTWorkerCleanupPreview";

describe("Worker cleanup preview with incomplete runtime evidence", () => {
  const sessions: BrowserSession[] = [
    { id: "manager", title: "Manager" },
    { id: "worker", title: "Worker", parentSessionId: "manager" },
    { id: "manual", title: "Manually linked", parentSessionId: "manager" },
    { id: "orphan", title: "Orphan", parentSessionId: "missing" },
    { id: "root", title: "Other user tab" },
    { id: "detached", title: "Detached", parentSessionId: null },
  ];

  it("shows only existing same-environment parent links but never calls them verified", () => {
    const preview = previewUnverifiedWorkerCleanup(sessions, [
      { sessionId: "worker", requestId: "spawn-request" },
    ]);
    expect(preview.map((row) => row.sessionId)).toEqual(["worker", "manual"]);
    expect(preview[0]).toMatchObject({
      parentSessionId: "manager",
      hasManagedSpawnReceipt: true,
    });
    expect(preview[0]?.blockReason).toMatch(/does not attest parent provenance/);
    expect(preview[1]).toMatchObject({
      hasManagedSpawnReceipt: false,
    });
    expect(preview[1]?.blockReason).toMatch(/not verified ownership/);
  });

  it("does not manufacture a verified link or Done receipt even when opted in and idle", () => {
    const completed: BrowserSession[] = sessions.map((session) =>
      session.id === "worker"
        ? {
            ...session,
            completion: {
              declaredAt: "2026-10-23T12:00:00Z",
              observedTurns: 4,
              observedUrl: "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            },
          }
        : session,
    );
    const preview = previewUnverifiedWorkerCleanup(completed, [
      { sessionId: "worker", requestId: "spawn-request" },
    ]);
    expect(preview.find((row) => row.sessionId === "worker")?.hasManagedSpawnReceipt).toBe(true);
    const plan = planChatGPTWorkerCleanup({
      sessions: completed,
      links: [],
      spawnReceipts: [{ sessionId: "worker", requestId: "spawn-request" }],
      doneReceipts: [],
      inspections: [],
      ledger: [],
      settings: {
        ...DEFAULT_WORKER_CLEANUP_SETTINGS,
        enabled: true,
        enabledAtMs: Date.parse("2026-10-23T11:00:00Z"),
      },
      nowMs: Date.parse("2026-10-23T17:00:00Z"),
      mode: "preview",
      startupReconciled: false,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.preview).toEqual([]);
  });
});
