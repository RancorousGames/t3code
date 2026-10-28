import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { previewNativeHistoryRetention } from "./nativeHistoryRetention.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const DAY = 86_400_000;
const at = (daysBefore: number) => DateTime.makeUnsafe(NOW - daysBefore * DAY);

function shell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    latestVisibleMessage: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    status: "idle",
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at(200),
    updatedAt: at(1),
    archivedAt: at(1),
    settledOverride: null,
    settledAt: at(1),
    deletedAt: null,
    createdBy: "user",
    creationSource: "web",
    ...overrides,
  };
}

describe("native history 180-day preview", () => {
  it("reports old inactive history but authorizes zero deletions without client state", () => {
    const result = previewNativeHistoryRetention([], [shell("old")], NOW);
    expect(result.provisionalCandidates).toBe(1);
    expect(result.exclusions.unverifiedClientState).toBe(1);
    expect(result.pruneEligible).toBe(0);
    expect(result.estimatedReclaimBytes).toBeNull();
    expect(result.samples).toEqual([
      { threadId: "old", exclusion: "unverifiedClientState", ageDays: 200 },
    ]);
  });

  it("exempts recent, active, queued, pinned, referenced and descendants", () => {
    const child = shell("child", {
      lineage: {
        rootThreadId: ThreadId.make("parent"),
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "fork",
      },
      createdAt: at(2),
    });
    const result = previewNativeHistoryRetention(
      [shell("active", { archivedAt: null, settledAt: null })],
      [
        shell("recent", { latestRunCompletedAt: at(179) }),
        shell("queued", { pendingBackgroundTasks: [{ taskId: "pending", kind: "command" }] }),
        shell("pinned", { pinnedAt: at(190) }),
        shell("parent"),
        child,
      ],
      NOW,
    );
    expect(result.provisionalCandidates).toBe(0);
    expect(result.exclusions).toEqual({
      recent: 2,
      active: 1,
      pending: 1,
      pinned: 1,
      referenced: 1,
      unverifiedClientState: 0,
    });
  });

  it("includes dormant settled native threads outside Archive without authorizing deletion", () => {
    const result = previewNativeHistoryRetention(
      [
        shell("settled", { archivedAt: null, settledAt: at(195) }),
        shell("unsettled", { archivedAt: null, settledAt: null }),
        shell("inconsistent", { archivedAt: at(1) }),
      ],
      [shell("archived"), shell("inconsistent")],
      NOW,
    );
    expect(result.scannedThreads).toBe(4);
    expect(result.provisionalCandidates).toBe(2);
    expect(result.pruneEligible).toBe(0);
    expect(result.exclusions.active).toBe(2);
    expect(result.exclusions.unverifiedClientState).toBe(2);
  });

  it("does not use metadata refreshes as conversation activity", () => {
    const result = previewNativeHistoryRetention([], [
      shell("candidate", { updatedAt: at(0), archivedAt: at(0) }),
    ], NOW);
    expect(result.provisionalCandidates).toBe(1);
  });
});
