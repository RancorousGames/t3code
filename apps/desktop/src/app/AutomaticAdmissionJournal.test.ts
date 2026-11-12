// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Temporary admission journal fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { CaffyScheduler } from "./CaffyScheduler.ts";

describe("automatic capacity admission", () => {
  it("spaces automatic launches and writes the capacity calculation across restarts", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-admission-"));
    const deliveries = {
      subscribeTransitions: () => {},
      setDispatchAdmission: () => {},
      setDispatchPermission: () => {},
      resumeAllowed: () => {},
    } as unknown as ConstructorParameters<typeof CaffyScheduler>[1];
    const request = (async () => {
      throw Error("Admission must not contact the ChatGPT browser");
    }) as ConstructorParameters<typeof CaffyScheduler>[2];
    const open = () => new CaffyScheduler(dir, deliveries, request, {
      start: () => 1, stop: () => {},
    });
    const first = open();
    try {
      first.policy({ keepT3Busy: true, maxWorking: 3 });
      first.reportWorkingSnapshot(["existing-worker"], "sidebar");
      first.setTaskReservations([], true);
      expect(await first.acquireAutomaticAdmission("first", undefined, false, "task:WT-0048")).toBe(true);
      first.releaseAutomaticAdmission("first");
      expect(await first.acquireAutomaticAdmission("second", undefined, false, "task:WT-0100")).toBe(false);
      const rows = NodeFS.readFileSync(NodePath.join(dir, "autowork-admissions.ndjson"), "utf8")
        .trim().split("\n").map(line => JSON.parse(line) as {
          event: string; target?: string; decision: string; reason: string;
          capacity?: { used: number; reserved: number; workingIds: string[]; limit: number };
        });
      expect(rows.find(row => row.target === "task:WT-0048")).toMatchObject({
        decision: "admitted", capacity: { used: 1, reserved: 0, limit: 3, workingIds: ["existing-worker"] },
      });
      expect(rows.find(row => row.target === "task:WT-0100")).toMatchObject({
        decision: "deferred", reason: "Automatic launch cooldown",
      });
      first.close();
      const restarted = open();
      try {
        restarted.reportWorkingSnapshot([], "sidebar");
        restarted.setTaskReservations([], true);
        expect(await restarted.acquireAutomaticAdmission("third")).toBe(false);
      } finally { restarted.close(); }
    } finally {
      first.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
