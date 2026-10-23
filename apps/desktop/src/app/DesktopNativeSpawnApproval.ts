export interface NativeApprovalView {
  operationId: string;
  descriptorSha256: string;
  stateVersion: number;
  status: string;
  expiresAt: string;
  target: {
    providerInstanceId: string;
    modelSlug: string;
    workspaceRoot: string;
    reasoningEffort: string | null;
    modelOptions: ReadonlyArray<{ id: string; value: string | boolean }> | null;
    resolvedExecutionPath: string | null;
  };
  requester: { verified: boolean };
  task: { preview: string; promptSha256: string };
}

export interface NativeApprovalPort {
  get(operationId: string): Promise<NativeApprovalView>;
  decide(input: {
    operationId: string;
    descriptorSha256: string;
    expectedVersion: number;
    decision: "approved" | "denied";
    actionId: string;
  }): Promise<NativeApprovalView>;
}

const safe = (s: string, max: number) =>
  // eslint-disable-next-line no-control-regex -- prevent control/bidi spoofing in privileged native prompts.
  s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);

/** MAIN owns both native prompts. Renderer/CLI input can only select an ID,
 * never a choice, user-verification result, nonce or approval proof. */
export class DesktopNativeSpawnApproval {
  readonly #active = new Set<string>();
  readonly ports: {
    authority: NativeApprovalPort;
    confirm: (view: {
      message: string;
      detail: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
    }) => Promise<{ response: number }>;
    verifyWindowsUser: (binding: string) => Promise<boolean>;
    newActionId: () => string;
    now: () => number;
  };
  constructor(ports: DesktopNativeSpawnApproval["ports"]) {
    this.ports = ports;
  }

  async review(
    operationId: string,
  ): Promise<"recorded" | "cancelled" | "verification-unavailable"> {
    if (this.#active.has(operationId)) throw new Error("This approval is already being reviewed");
    this.#active.add(operationId);
    try {
      const item = await this.ports.authority.get(operationId);
      if (
        item.operationId !== operationId ||
        item.status !== "pending_approval" ||
        !Number.isSafeInteger(item.stateVersion) ||
        item.stateVersion < 1 ||
        !/^[a-f0-9]{64}$/.test(item.descriptorSha256) ||
        !Number.isFinite(Date.parse(item.expiresAt)) ||
        Date.parse(item.expiresAt) <= this.ports.now()
      )
        throw new Error("Approval is stale, expired or does not match the requested operation");
      // Snapshot authority data before any UI await; all later writes bind to
      // exactly this version/digest, never a mutable renderer object.
      const snapshot = structuredClone(item);
      const canApprove =
        snapshot.requester.verified &&
        snapshot.target.modelOptions !== null &&
        snapshot.target.resolvedExecutionPath !== null;
      const choice = await this.ports.confirm({
        message: `Native session: ${safe(snapshot.target.modelSlug, 100)}`,
        detail: [
          `Provider: ${safe(snapshot.target.providerInstanceId, 100)}`,
          `Effort: ${safe(snapshot.target.reasoningEffort ?? "unspecified", 40)}`,
          `Workspace: ${safe(snapshot.target.workspaceRoot, 500)}`,
          `Requester: ${snapshot.requester.verified ? "transport verified" : "UNVERIFIED; cannot approve"}`,
          `Execution binding: ${canApprove ? "resolved" : "unresolved; approval unavailable"}`,
          `Operation: ${safe(snapshot.operationId, 256)}`,
          `Version: ${snapshot.stateVersion}`,
          `Digest: ${snapshot.descriptorSha256}`,
          `Expires: ${snapshot.expiresAt}`,
          "Cost unavailable. Task preview is untrusted request content:",
          safe(snapshot.task.preview, 1000),
        ].join("\n"),
        buttons: ["Cancel", "Deny", ...(canApprove ? ["Approve once"] : [])],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice.response === 0) return "cancelled";
      if (choice.response !== 1 && (choice.response !== 2 || !canApprove))
        throw new Error("Invalid native decision");
      const decision = choice.response === 2 ? "approved" : "denied";
      const binding = `${decision}\n${snapshot.operationId}\n${snapshot.descriptorSha256}\n${snapshot.stateVersion}`;
      // Native dialog selection alone is not proof of a physical operator:
      // require fresh Windows Hello consent, inaccessible to web automation.
      if (!(await this.ports.verifyWindowsUser(binding))) return "verification-unavailable";
      if (Date.parse(snapshot.expiresAt) <= this.ports.now())
        throw new Error("Approval expired during verification");
      const recorded = await this.ports.authority.decide({
        operationId: snapshot.operationId,
        descriptorSha256: snapshot.descriptorSha256,
        expectedVersion: snapshot.stateVersion,
        decision,
        actionId: this.ports.newActionId(),
      });
      if (
        recorded.operationId !== snapshot.operationId ||
        recorded.descriptorSha256 !== snapshot.descriptorSha256 ||
        recorded.stateVersion !== snapshot.stateVersion + 1 ||
        recorded.status !== decision
      )
        throw new Error("Canonical decision receipt unconfirmed; do not retry automatically");
      return "recorded";
    } finally {
      this.#active.delete(operationId);
    }
  }
}
