import { describe, expect, it } from "vite-plus/test";
import { nativeV2ExecutionReceipt } from "./openRigNativeExecutionReceipts.js";
const base = { seatId: "managed-seat", environmentId: "env", threadId: "thread", eventId: "event-1",
  runId: "run-1", occurredAt: "2026-10-29T00:00:00Z" };
describe("V2 native execution receipt normalization", () => {
  it("separates committed run phases and ignores noncommittal state", () => {
    const created = nativeV2ExecutionReceipt({ ...base, eventType: "run.created", status: "queued" });
    expect(created?.phase).toBe("accepted-intent");
    const running = nativeV2ExecutionReceipt({ ...base, eventType: "run.updated", status: "running", eventId: "event-2" });
    expect(running?.phase).toBe("run-started");
    expect(nativeV2ExecutionReceipt({ ...base, eventType: "run.updated", status: "waiting" })).toBeNull();
    const finished = nativeV2ExecutionReceipt({ ...base, eventType: "run.updated", status: "completed", eventId: "event-3" });
    expect(finished?.phase).toBe("result-committed");
    expect(finished?.origin).toEqual({ kind: "native", environmentId: "env", threadId: "thread", generation: "run-1" });
    expect(nativeV2ExecutionReceipt({ ...base, eventType: "run.updated", status: "failed" })?.phase).toBe("terminal");
    expect([created?.phase, running?.phase, finished?.phase]).not.toContain("delivery-observed");
  });
});
