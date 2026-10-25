import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopOpenRigNativeApproval } from "@t3tools/contracts";
import { OpenRigSpawnApprovalPanel, OpenRigCanonicalSpawnApprovals, canonicalApprovalToView, SPAWN_APPROVAL_FEED_UNAVAILABLE, type SpawnApprovalRequestView } from "./OpenRigSpawnApproval";

let renderer: ReactTestRenderer | null = null;
const request: SpawnApprovalRequestView = {
  id: "op-123", operationId: "op-123", status: "pending_approval",
  requestedBy: { kind: "unknown" }, sourceThread: null,
  destinationSeatId: "seat/b",
  target: {
    environmentId: "local", providerInstanceId: "codex",
    model: "gpt-6-astra", effort: "high", runtime: "codex", runtimeMode: "approval-required",
  },
  exemption: "unknown", workspaceRoot: "D:\\Projects\\Example", projectId: "example",
  taskPreview: "Review the release", requestedAt: "2026-10-19T08:00:00.000Z",
  expiresAt: "2099-10-19T08:00:00.000Z", decision: null,
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { localStorage: { getItem: () => null } });
});
afterEach(() => { if (renderer) act(() => renderer?.unmount()); renderer = null; vi.unstubAllGlobals(); });
async function mount(feed: Parameters<typeof OpenRigSpawnApprovalPanel>[0]["feed"]) {
  await act(async () => {
    renderer = create(<OpenRigSpawnApprovalPanel feed={feed} seatId={null} seatName={id => id} />);
  });
}
function output() { return JSON.stringify(renderer!.toJSON()); }

describe("OpenRig approvals must fail closed pending canonical writer", () => {
  it("labels the real live feed as unavailable and exposes no operator decision action", async () => {
    await mount(SPAWN_APPROVAL_FEED_UNAVAILABLE);
    expect(output()).toContain("history is not available in this desktop build");
    expect(output()).not.toContain("not enforced yet");
    expect(output()).not.toContain("RED");
    expect(output()).not.toContain("Approve once");
    expect(output()).not.toContain("Deny");
  });

  it("even a displayed pending request with an unknown caller has no action without trusted decision writer", async () => {
    await mount({ kind: "ready", requests: [request] });
    expect(output()).toContain("Unknown caller (unverified)");
    expect(output()).toContain("Exemption unverified");
    expect(output()).toContain("effort high");
    expect(output()).toContain("not proven");
    expect(output()).not.toContain("Approve once");
    expect(output()).not.toContain("Deny");
  });

  it("renders conflict and expired lifecycle evidence as read-only without claiming execution", async () => {
    await mount({ kind: "ready", requests: [
      { ...request, id: "op-denied", status: "denied", decision: { outcome: "denied", actor: "human@kernel", at: "2026-10-19T08:30:00Z" } },
      { ...request, id: "op-expired", status: "expired" },
      { ...request, id: "op-indeterminate", status: "indeterminate" },
    ] });
    expect(output()).toContain("Denied");
    expect(output()).toContain("Expired");
    expect(output()).toContain("Launch outcome is unknown");
    expect(output()).not.toContain("Approve once");
  });
});


const canonical: DesktopOpenRigNativeApproval = {
  id: "req-verified",
  operationId: "thread:mcp:session:request:0",
  descriptorSha256: "c".repeat(64),
  stateVersion: 4,
  status: "pending_approval",
  requestedAt: "2026-10-19T08:00:00.000Z",
  expiresAt: "2099-10-19T08:00:00.000Z",
  target: {
    environmentId: "env-target",
    providerInstanceId: "codex",
    driver: "codex",
    modelSlug: "gpt-6-astra",
    modelOptions: [{ id: "reasoningEffort", value: "high" }],
    reasoningEffort: "high",
    runtimeMode: "approval-required",
    projectId: "target-project",
    workspaceRoot: "D:\\workspace",
    resolvedExecutionPath: "D:\\workspace",
  },
  requester: {
    verified: true,
    callerSeatId: "seat-a",
    sourceThreadId: "origin-thread",
    parentThreadId: null,
  },
  task: { title: "Review task", preview: "Untrusted prompt content", promptSha256: "b".repeat(64) },
  decisionWriteAvailable: false,
  estimatedCostUsd: null,
};

describe("MAIN-only canonical approval reads and native review routing", () => {
  it("never invents origin environment, destination seat, model exemption or approval authority", () => {
    const view = canonicalApprovalToView(canonical);
    expect(view).toMatchObject({
      operationId: canonical.operationId,
      descriptorSha256: canonical.descriptorSha256,
      stateVersion: 4,
      requestedBy: { kind: "verified-seat", seatId: "seat-a" },
      verifiedSourceThreadId: "origin-thread",
      sourceThread: null,
      destinationSeatId: null,
      exemption: "unknown",
    });
    expect(canonicalApprovalToView({ ...canonical, requester: { ...canonical.requester, verified: false } }))
      .toMatchObject({ requestedBy: { kind: "unknown" }, verifiedSourceThreadId: null });
  });

  it("Inbox and requester-seat panels show the same canonical ID/version/digest and renderer requests native review by ID only", async () => {
    const get = vi.fn(async () => ({ ...canonical }));
    const list = vi.fn(async () => ({
      source: "openrig-canonical-sqlite",
      address: "human@kernel",
      items: [canonical], count: 1, truncated: false,
      nextCursor: null, decisionWriteAvailable: false, executionReserveAvailable: false,
      note: "Canonical native approvals",
    }));
    const review = vi.fn(async (_operationId: string) => ({
      outcome: "recorded" as const, item: { ...canonical, stateVersion: 5, status: "denied" as const },
    }));
    vi.stubGlobal("window", {
      desktopBridge: {
        getOpenRigNativeApproval: get,
        listPendingOpenRigNativeApprovals: list,
        requestOpenRigNativeReview: review,
      },
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    });
    await act(async () => {
      renderer = create(<OpenRigCanonicalSpawnApprovals seatId="seat-a" seatName={(id) => id} />);
    });
    expect(output()).not.toContain("Native approval release");
    expect(output()).not.toContain("Source-only review wiring");
    expect(output()).toContain(canonical.operationId);
    expect(output()).toContain(canonical.descriptorSha256);
    expect(output()).toContain("Canonical version");
    expect(output()).toContain("origin-thread");
    expect(output()).toContain("environment not recorded");
    expect(output()).toContain("Review in native desktop dialog");
    const buttons = renderer!.root.findAllByType("button");
    const native = buttons.find((button) => JSON.stringify(button.props.children).includes("Review in native desktop dialog"));
    expect(native).toBeDefined();
    await act(async () => {
      await native!.props.onClick();
    });
    expect(review).toHaveBeenCalledExactlyOnceWith(canonical.operationId);
    expect(output()).toContain("denied");
    expect(output()).toContain("Check the operation status for launch outcome");
    expect(output()).not.toContain("Approve once");
    expect(output()).not.toContain("Deny");
  });

  it("fails visibly rather than pretending an unavailable authority is an empty inbox", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { listPendingOpenRigNativeApprovals: vi.fn(async () => { throw new Error("Attestation refused"); }) },
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    });
    await act(async () => {
      renderer = create(<OpenRigCanonicalSpawnApprovals seatId={null} seatName={(id) => id} />);
    });
    expect(output()).toContain("Attestation refused");
    expect(output()).toContain("Spawn approvals unavailable");
    expect(output()).not.toContain("Native approval release");
    expect(output()).not.toContain("Source-only review wiring");
    expect(output()).not.toContain("No spawn approval requests");
  });
});
