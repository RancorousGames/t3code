// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Disposable scheduler fixture with bounded timer polling.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { CaffyScheduler, type CaffyConfig } from "./CaffyScheduler.ts";

const ENV = "native-environment";
const THREAD = "thread:mcp:luna-low-fixture";
const OWNER = `t3:${ENV}:${THREAD}`;

function fixture(options?: { lostSendAck?: boolean; missingThread?: boolean }) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-native-caffy-"));
  const sent: string[] = [];
  const seen = new Set<string>();
  let revealReceipt = !options?.lostSendAck;
  let latestRun: { ordinal: number; status: string } | null = null;
  let status = "idle";
  const request = (async (input: {
    requestId: string;
    type?: string;
    action?: string;
    threadId?: string;
    environmentId?: string;
    clientRequestId?: string;
    message?: string;
  }) => {
    const base = { version: 1, requestId: input.requestId };
    if (input.type === "t3.threads") {
      if (input.action === "list")
        return {
          ...base,
          ok: true,
          data: {
            environmentId: ENV,
            threads: options?.missingThread ? [] : [{ id: THREAD, status }],
          },
        };
      if (options?.missingThread || input.threadId !== THREAD || input.environmentId !== ENV)
        return { ...base, ok: false, code: "invalid-request", message: "Unknown native thread." };
      if (input.action === "read")
        return {
          ...base,
          ok: true,
          data: {
            environmentId: ENV,
            threadId: THREAD,
            status,
            latestRun,
            messageSeen: revealReceipt && seen.has(input.clientRequestId ?? ""),
          },
        };
      if (input.action === "send") {
        const id = input.clientRequestId!;
        sent.push(id);
        seen.add(id);
        latestRun = { ordinal: (latestRun?.ordinal ?? 0) + 1, status: "running" };
        status = "running";
        return options?.lostSendAck
          ? { ...base, ok: false, code: "renderer-unavailable", message: "Reply lost." }
          : {
              ...base,
              ok: true,
              data: { environmentId: ENV, threadId: THREAD, messageId: id, messageSent: true },
            };
      }
    }
    return { ...base, ok: true, data: { sessions: [], total: 0 } };
  }) as ConstructorParameters<typeof CaffyScheduler>[2];
  const deliveries = {
    subscribeTransitions: () => () => {},
    setDispatchPermission: () => {},
    setDispatchAdmission: () => {},
    resumeAllowed: () => {},
    retireRecipient: () => 0,
  } as unknown as ConstructorParameters<typeof CaffyScheduler>[1];
  const open = () =>
    new CaffyScheduler(
      directory,
      deliveries,
      request,
      {
        start: () => 1,
        stop: () => {},
      },
      () => {
        throw new Error("Native Caffy test must not shut down the PC.");
      },
    );
  const complete = () => {
    status = "idle";
    if (latestRun) latestRun = { ...latestRun, status: "completed" };
  };
  const poll = (caffy: CaffyScheduler) =>
    (caffy as unknown as { pump: () => Promise<void> }).pump();
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 50; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Native Caffy did not reach the expected state.");
  };
  const dispose = () => NodeFS.rmSync(directory, { recursive: true, force: true });
  return {
    open,
    complete,
    poll,
    until,
    sent,
    seen,
    allowReceipt: () => {
      revealReceipt = true;
    },
    dispose,
    directory,
  };
}

describe("Caffy native T3 thread lifecycle (GPT-6 Luna low target)", () => {
  it("resumes the exact thread, waits for native run completion, and respects pause/resume", async () => {
    const f = fixture();
    const c = f.open();
    try {
      c.start();
      const row = await c.set({
        targetKind: "t3",
        sessionId: THREAD,
        environmentId: ENV,
        conversationId: "",
        mode: "idle",
        keepAwake: false,
      });
      expect(row).toMatchObject({
        targetKind: "t3",
        sessionId: OWNER,
        nativeThreadId: THREAD,
        environmentId: ENV,
      });
      await f.until(() => f.sent.length === 1);
      c.reportWorkingSnapshot([], "sidebar");
      expect(await c.capacity()).toMatchObject({ working: 1, used: 1 });
      await f.poll(c);
      expect(f.sent).toHaveLength(1); // Active model still running; never queue an extra wake.
      c.pause(OWNER, true);
      f.complete();
      await f.poll(c);
      expect(f.sent).toHaveLength(1);
      c.pause(OWNER, false);
      await f.until(() => f.sent.length === 2);
      expect(new Set(f.sent).size).toBe(2);
      await f.poll(c);
      expect(f.sent).toHaveLength(2);
      expect(c.status(OWNER)).toMatchObject({ targetKind: "t3", paused: false });
    } finally {
      c.close();
      f.dispose();
    }
  });

  it("reconciles uncertain native send by exact persisted message ID after restart", async () => {
    const f = fixture({ lostSendAck: true });
    let c = f.open();
    try {
      c.start();
      await c.set({
        targetKind: "t3",
        sessionId: THREAD,
        environmentId: ENV,
        conversationId: "",
        mode: "idle",
        keepAwake: false,
      });
      await f.until(() => f.sent.length === 1);
      const pending = c.status(OWNER) as CaffyConfig;
      expect(pending.pendingMessageId).toBe(f.sent[0]);
      c.close();
      f.allowReceipt();
      c = f.open();
      c.start();
      await f.until(() => (c.status(OWNER) as CaffyConfig).pendingMessageId === null);
      expect(f.sent).toHaveLength(1); // Projection receipt, not a second submission.
      expect(c.status(OWNER)).toMatchObject({
        pendingMessageId: null,
        deliveryStatus: "delivered",
      });
    } finally {
      c.close();
      f.dispose();
    }
  });

  it("refuses to schedule an unverified native thread", async () => {
    const f = fixture({ missingThread: true });
    const c = f.open();
    try {
      await expect(
        c.set({
          targetKind: "t3",
          sessionId: THREAD,
          environmentId: ENV,
          conversationId: "",
          mode: "idle",
        }),
      ).rejects.toThrow("Cannot verify");
      expect(c.status(OWNER)).toBeNull();
    } finally {
      c.close();
      f.dispose();
    }
  });
});
