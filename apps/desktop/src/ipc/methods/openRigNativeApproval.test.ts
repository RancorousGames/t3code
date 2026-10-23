import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, vi } from "vite-plus/test";

import * as ElectronDialog from "../../electron/ElectronDialog.ts";

const mocks = vi.hoisted(() => ({
  pending: vi.fn(), get: vi.fn(), review: vi.fn(),
}));

vi.mock("../../app/DesktopOpenRigApprovalHost.ts", () => ({
  listPendingNativeSpawnApprovals: mocks.pending,
  getNativeSpawnApproval: mocks.get,
  reviewNativeSpawnOperation: mocks.review,
}));

import {
  getOpenRigNativeApproval, listPendingOpenRigNativeApprovals, requestOpenRigNativeReview,
} from "./openRig.ts";

const operationId = "origin:thread:operation:1";
const item = {
  id: "canonical-request-1",
  operationId,
  descriptorSha256: "a".repeat(64),
  stateVersion: 4,
  status: "pending_approval",
  requestedAt: "2026-10-20T00:01:00.000Z",
  expiresAt: "2099-10-20T00:03:00.000Z",
  target: {
    environmentId: "env-1", providerInstanceId: "codex", driver: "codex",
    modelSlug: "gpt-6-astra", modelOptions: [], reasoningEffort: null,
    runtimeMode: "approval-required", projectId: "project-1",
    workspaceRoot: "D:\\example", resolvedExecutionPath: "D:\\example",
  },
  requester: { verified: true, callerSeatId: "seat/1", sourceThreadId: "thread/1", parentThreadId: null },
  task: { title: "Task", preview: "Untrusted task", promptSha256: "b".repeat(64) },
  decisionWriteAvailable: false,
  estimatedCostUsd: null,
};
const canonicalPage = {
  source: "openrig-canonical-sqlite", address: "human@kernel",
  items: [item], count: 1, truncated: false, nextCursor: null,
  decisionWriteAvailable: false, executionReserveAvailable: false,
  note: "Source-only, not deployed",
};
const fakeDialog = {
  showMessageBox: () => Effect.succeed({ response: 0 }),
} as unknown as ElectronDialog.ElectronDialog["Service"];

beforeEach(() => {
  mocks.pending.mockReset();
  mocks.get.mockReset();
  mocks.review.mockReset();
  mocks.pending.mockResolvedValue(canonicalPage);
  mocks.get.mockResolvedValue(item);
  mocks.review.mockResolvedValue({ outcome: "cancelled", item });
});

describe("T3 MAIN OpenRig approval IPC guards", () => {
  it.effect("reads immutable canonical projection only; no HTTP or renderer decision", () =>
    Effect.gen(function* () {
      const page = yield* listPendingOpenRigNativeApprovals.handler(undefined);
      expect(page).toMatchObject({
        source: "openrig-canonical-sqlite",
        decisionWriteAvailable: false,
        executionReserveAvailable: false,
        items: [{ operationId, descriptorSha256: "a".repeat(64), stateVersion: 4 }],
      });
      expect(mocks.pending).toHaveBeenCalledOnce();
      const result = yield* getOpenRigNativeApproval.handler(operationId);
      expect(result).toMatchObject({ operationId, descriptorSha256: "a".repeat(64), stateVersion: 4 });
      expect(mocks.get).toHaveBeenCalledExactlyOnceWith(operationId);
      expect(mocks.review).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects spoofed approve/isHuman/actionId payload before opening native UI", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(requestOpenRigNativeReview.handler({
        operationId, decision: "approved", isHuman: true, actionId: "forged",
      }).pipe(Effect.provideService(ElectronDialog.ElectronDialog, fakeDialog)));
      expect(result._tag).toBe("Failure");
      expect(mocks.review).not.toHaveBeenCalled();
    }),
  );

  it.effect("renderer supplies only opaque ID; MAIN owns actual native dialog invocation", () =>
    Effect.gen(function* () {
      const showMessageBox = vi.fn(() => Effect.succeed({ response: 0 }));
      const dialog = { showMessageBox } as unknown as ElectronDialog.ElectronDialog["Service"];
      mocks.review.mockImplementation(async (id: string, confirm: (args: {
        message: string; detail: string; buttons: string[];
        defaultId: number; cancelId: number;
      }) => Promise<{ response: number }>) => {
        expect(id).toBe(operationId);
        const choice = await confirm({
          message: "Read-only canonical operation",
          detail: "Native review not yet enforced in running app",
          buttons: ["Cancel"], defaultId: 0, cancelId: 0,
        });
        expect(choice).toEqual({ response: 0 });
        return { outcome: "cancelled", item };
      });
      const value = yield* requestOpenRigNativeReview.handler(operationId).pipe(
        Effect.provideService(ElectronDialog.ElectronDialog, dialog),
      );
      expect(value).toMatchObject({ outcome: "cancelled", item: { operationId, stateVersion: 4 } });
      expect(mocks.review).toHaveBeenCalledExactlyOnceWith(operationId, expect.any(Function));
      expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        buttons: ["Cancel"], defaultId: 0, cancelId: 0, noLink: true,
      }));
    }),
  );

  it.effect("rejects malformed canonical status rather than pretending the inbox is empty", () =>
    Effect.gen(function* () {
      mocks.pending.mockResolvedValue({ ...canonicalPage, source: "renderer-claimed", items: [] });
      const result = yield* Effect.exit(listPendingOpenRigNativeApprovals.handler(undefined));
      expect(result._tag).toBe("Failure");
      expect(mocks.review).not.toHaveBeenCalled();
    }),
  );

  it.effect("does not turn a lost native authority reply into recorded approval", () =>
    Effect.gen(function* () {
      mocks.review.mockRejectedValue(new Error("private channel disconnected"));
      const result = yield* Effect.exit(requestOpenRigNativeReview.handler(operationId).pipe(
        Effect.provideService(ElectronDialog.ElectronDialog, fakeDialog),
      ));
      expect(result._tag).toBe("Failure");
      expect(mocks.review).toHaveBeenCalledOnce();
    }),
  );
});
