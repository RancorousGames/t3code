import { describe, expect, it } from "vite-plus/test";
import {
  OpenRigExecutionReceiptJournal,
  openRigHttpReceiptTransport,
  openRigHttpReceiptLookup,
  drainOpenRigExecutionReceipts,
  toVerifiedExecutionReceipt,
  type ExecutionReceiptInput,
  type KeyValueStorage,
} from "./openRigExecutionReceiptBridge.js";

function storage(): KeyValueStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}
const trustedSeats = new Set(["verified-seat"]);
const base: ExecutionReceiptInput = {
  seatId: "verified-seat",
  origin: {
    kind: "chatgpt",
    environmentId: "env-1",
    browserSessionId: "browser-1",
    conversationId: "conversation-1",
    generation: "generation-1",
  },
  sourceEventId: "source-event-1",
  phase: "accepted-intent",
  at: "2026-10-28T20:00:00.000Z",
};

describe("OpenRig verified T3 receipt adapter", () => {
  it("refuses a guessed seat or an asserted delivery without independent evidence", () => {
    expect(() => toVerifiedExecutionReceipt({ ...base, seatId: "guessed" }, trustedSeats)).toThrow(
      "unverified",
    );
    expect(() =>
      toVerifiedExecutionReceipt({ ...base, phase: "delivery-observed" }, trustedSeats),
    ).toThrow("requires");
    expect(
      toVerifiedExecutionReceipt({ ...base, phase: "accepted-intent" }, trustedSeats).phase,
    ).toBe("accepted-intent");
    expect(
      toVerifiedExecutionReceipt(
        {
          ...base,
          phase: "delivery-observed",
          observedDeliveryId: "turn-17",
        },
        trustedSeats,
      ).phase,
    ).toBe("delivery-observed");
  });

  it("retains exact source/generation identity and deduplicates retries after remount and acceptance", () => {
    const store = storage();
    const receipt = toVerifiedExecutionReceipt(base, trustedSeats);
    const journal = new OpenRigExecutionReceiptJournal(store, "env-1");
    expect(journal.append(receipt)).toBe(true);
    expect(journal.entries()[0]?.cursor).toBe(1);
    expect(new OpenRigExecutionReceiptJournal(store, "env-1").append(receipt)).toBe(false);
    journal.markOutcome(receipt.receiptId, "accepted", "openrig-event-1");
    expect(journal.pending()).toHaveLength(0);
    const reopened = new OpenRigExecutionReceiptJournal(store, "env-1");
    expect(reopened.append(receipt)).toBe(false);
    expect(reopened.entries()).toHaveLength(1);
    expect(() => reopened.append({ ...receipt, at: "2026-10-28T21:00:00.000Z" })).toThrow(
      "Conflicting",
    );
    expect(() => reopened.markOutcome(receipt.receiptId, "unknown")).toThrow("Cannot revert");
    expect(reopened.entries()[0]?.externalReceiptId).toBe("openrig-event-1");
  });

  it("retains UNKNOWN for reconciliation rather than replaying the same external message", () => {
    const store = storage();
    const receipt = toVerifiedExecutionReceipt(base, trustedSeats);
    const journal = new OpenRigExecutionReceiptJournal(store, "env-1");
    journal.append(receipt);
    journal.markOutcome(receipt.receiptId, "unknown");
    const reopened = new OpenRigExecutionReceiptJournal(store, "env-1");
    expect(reopened.pending()).toHaveLength(0);
    expect(reopened.unknown()).toEqual([receipt]);
    reopened.markOutcome(receipt.receiptId, "verified-not-observed");
    expect(reopened.pending()).toEqual([receipt]);
  });

  it("reconciles UNKNOWN only after exact external observation", async () => {
    const store = storage();
    const journal = new OpenRigExecutionReceiptJournal(store, "env-1");
    const receipt = toVerifiedExecutionReceipt(base, trustedSeats);
    journal.append(receipt);
    journal.markOutcome(receipt.receiptId, "unknown");
    expect(await journal.reconcileUnknown(receipt.receiptId, async () => ({ kind: "inconclusive" }))).toBe("unknown");
    expect(journal.pending()).toHaveLength(0);
    expect(await journal.reconcileUnknown(receipt.receiptId, async (candidate) => {
      expect(candidate.receiptId).toBe(receipt.receiptId);
      return { kind: "accepted", externalReceiptId: "openrig-ack-9" };
    })).toBe("accepted");
    expect(journal.entries()[0]?.externalReceiptId).toBe("openrig-ack-9");
    await expect(journal.reconcileUnknown(receipt.receiptId, async () => ({ kind: "verified-not-observed" }))).rejects.toThrow("Only UNKNOWN");
  });
  it("assigns monotonic cursors and isolates exact native and browser generations", () => {
    const store = storage();
    const journal = new OpenRigExecutionReceiptJournal(store, "env-1");
    const first = toVerifiedExecutionReceipt(base, trustedSeats);
    const second = toVerifiedExecutionReceipt(
      {
        ...base,
        origin: {
          kind: "native",
          environmentId: "env-1",
          threadId: "thread-1",
          generation: "run-42",
        },
        sourceEventId: "command-abc",
        phase: "run-started",
      },
      trustedSeats,
    );
    const third = toVerifiedExecutionReceipt(
      {
        ...base,
        origin: { ...base.origin, generation: "generation-2" },
      },
      trustedSeats,
    );
    journal.append(first);
    journal.append(second);
    journal.append(third);
    expect(journal.entries().map((entry) => entry.cursor)).toEqual([1, 2, 3]);
    expect(journal.entries(1).map((entry) => entry.receipt.receiptId)).toEqual([
      second.receiptId,
      third.receiptId,
    ]);
    expect(new Set(journal.entries().map((entry) => entry.receipt.receiptId)).size).toBe(3);
  });

  it("uses exact HTTP receipt identity and refuses ambiguous remote acknowledgements", async () => {
    const receipt = toVerifiedExecutionReceipt(base, trustedSeats);
    const requests: string[] = [];
    const request = (async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ accepted: true, externalReceiptId: receipt.receiptId }), { status: 200 });
    }) as typeof fetch;
    const send = openRigHttpReceiptTransport("http://127.0.0.1:4000/api/integrations/t3/", "test-token", request);
    expect(await send(receipt)).toEqual({ kind: "accepted", externalReceiptId: receipt.receiptId });
    const lookup = openRigHttpReceiptLookup("http://127.0.0.1:4000/api/integrations/t3/", "test-token",
      (async () => new Response(JSON.stringify({ kind: "accepted", externalReceiptId: receipt.receiptId }))) as typeof fetch);
    expect(await lookup(receipt)).toEqual({ kind: "accepted", externalReceiptId: receipt.receiptId });
    expect(requests[0]).toBe("http://127.0.0.1:4000/api/integrations/t3/execution-receipts");
    expect(await openRigHttpReceiptTransport("http://host", "token",
      (async () => new Response("unavailable", { status: 503 })) as typeof fetch)(receipt)).toEqual({ kind: "unknown" });
  });
  it("requires an OpenRig ack before marking delivery and quarantines ambiguous sends", async () => {
    const store = storage();
    const journal = new OpenRigExecutionReceiptJournal(store, "env-1");
    const first = toVerifiedExecutionReceipt(base, trustedSeats);
    const second = toVerifiedExecutionReceipt(
      { ...base, sourceEventId: "source-event-2" },
      trustedSeats,
    );
    journal.append(first);
    journal.append(second);
    const invoked: string[] = [];
    const outcome = await drainOpenRigExecutionReceipts(
      journal,
      "env-1:openrig",
      async (receipt) => {
        invoked.push(receipt.receiptId);
        if (receipt.receiptId === first.receiptId)
          return { kind: "accepted", externalReceiptId: "openrig-ack-1" };
        throw new Error("network timeout after possible acceptance");
      },
    );
    expect(outcome.map((item) => item.outcome)).toEqual(["accepted", "unknown"]);
    expect(journal.pending()).toHaveLength(0);
    expect(journal.unknown()).toEqual([second]);
    const resumed = new OpenRigExecutionReceiptJournal(store, "env-1");
    const secondAttempt = await drainOpenRigExecutionReceipts(
      resumed,
      "env-1:openrig",
      async () => {
        throw new Error("UNKNOWN must never be automatically re-sent");
      },
    );
    expect(secondAttempt).toHaveLength(0);
    expect(invoked).toEqual([first.receiptId, second.receiptId]);
  });
});
