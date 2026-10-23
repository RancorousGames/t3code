import { describe, expect, it, vi } from "vite-plus/test";
import {
  DesktopNativeSpawnApproval,
  type NativeApprovalView,
} from "./DesktopNativeSpawnApproval.ts";

const item = (): NativeApprovalView => ({
  operationId: "thread:mcp:session:request:0",
  descriptorSha256: "a".repeat(64),
  stateVersion: 1,
  status: "pending_approval",
  expiresAt: "2026-10-20T12:15:00.000Z",
  target: {
    providerInstanceId: "codex",
    modelSlug: "gpt-6-astra",
    workspaceRoot: "D:\\workspace",
    reasoningEffort: "high",
    modelOptions: [],
    resolvedExecutionPath: "D:\\workspace",
  },
  requester: { verified: true },
  task: { preview: "Untrusted task", promptSha256: "b".repeat(64) },
});
function harness(response = 2, verified = true) {
  const view = item();
  const confirm = vi.fn(async () => ({ response }));
  const verifyWindowsUser = vi.fn(async () => verified);
  const decide = vi.fn(async (input: { decision: "approved" | "denied" }) => ({
    ...view,
    stateVersion: 2,
    status: input.decision,
  }));
  const now = vi.fn(() => Date.parse("2026-10-20T12:00:00.000Z"));
  const controller = new DesktopNativeSpawnApproval({
    authority: { get: async () => view, decide },
    confirm,
    verifyWindowsUser,
    newActionId: () => "22222222-2222-4222-8222-222222222222",
    now,
  });
  return { view, confirm, verifyWindowsUser, decide, now, controller };
}

describe("MAIN-owned native spawn confirmation", () => {
  it("writes the exact displayed operation/version/digest only after native choice and Windows Hello", async () => {
    const h = harness();
    await expect(h.controller.review(h.view.operationId)).resolves.toBe("recorded");
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ defaultId: 0, cancelId: 0 }));
    expect(h.verifyWindowsUser).toHaveBeenCalledWith(
      `approved\n${h.view.operationId}\n${h.view.descriptorSha256}\n1`,
    );
    expect(h.decide).toHaveBeenCalledWith({
      operationId: h.view.operationId,
      descriptorSha256: h.view.descriptorSha256,
      expectedVersion: 1,
      decision: "approved",
      actionId: "22222222-2222-4222-8222-222222222222",
    });
  });
  it("does not write on native cancel", async () => {
    const h = harness(0);
    expect(await h.controller.review(h.view.operationId)).toBe("cancelled");
    expect(h.verifyWindowsUser).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
  });
  it("native dialog response alone cannot authenticate a human", async () => {
    const h = harness(2, false);
    expect(await h.controller.review(h.view.operationId)).toBe("verification-unavailable");
    expect(h.decide).not.toHaveBeenCalled();
  });
  it("does not approve an unverified requester even if a forged dialog result says approve", async () => {
    const h = harness();
    h.view.requester.verified = false;
    await expect(h.controller.review(h.view.operationId)).rejects.toThrow(
      "Invalid native decision",
    );
    expect(h.decide).not.toHaveBeenCalled();
  });
  it("rejects expiry during Windows Hello", async () => {
    const h = harness();
    h.verifyWindowsUser.mockImplementation(async () => {
      h.now.mockReturnValue(Date.parse("2026-10-20T12:15:00.000Z"));
      return true;
    });
    await expect(h.controller.review(h.view.operationId)).rejects.toThrow("expired");
    expect(h.decide).not.toHaveBeenCalled();
  });
  it("does not silently rebind an operation changed while the dialog was open", async () => {
    const h = harness();
    h.confirm.mockImplementation(async () => {
      h.view.stateVersion = 9;
      h.view.descriptorSha256 = "c".repeat(64);
      return { response: 2 };
    });
    await expect(h.controller.review(h.view.operationId)).rejects.toThrow("receipt unconfirmed");
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.decide).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 1, descriptorSha256: "a".repeat(64) }),
    );
  });
  it("never retries a lost canonical decision response", async () => {
    const h = harness();
    h.decide.mockRejectedValue(new Error("reply lost"));
    await expect(h.controller.review(h.view.operationId)).rejects.toThrow("reply lost");
    expect(h.decide).toHaveBeenCalledOnce();
  });
});
