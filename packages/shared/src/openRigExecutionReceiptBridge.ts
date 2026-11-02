/**
 * T3-0178: transport-neutral receipt bridge for verified OpenRig seats.
 * No executor dispatches work here. V2 remains responsible for native turns;
 * the ChatGPT delivery queue remains responsible for browser sends.
 *
 * The canonical OpenRig API/consumer supplies a *verified* seat-id set, accepts
 * receipts idempotently using receiptId, and confirms delivery independently.
 */
export type ExecutionOrigin =
  | { kind: "native"; environmentId: string; threadId: string; generation: string }
  | {
      kind: "chatgpt";
      environmentId: string;
      browserSessionId: string;
      conversationId: string;
      generation: string;
    };

export type ExecutionPhase =
  | "accepted-intent"
  | "run-started"
  | "result-committed"
  | "delivery-observed"
  | "unknown"
  | "terminal";

export interface ExecutionReceiptInput {
  readonly seatId: string;
  readonly origin: ExecutionOrigin;
  /** A durable source event/command ID, never a renderer timestamp or tab title. */
  readonly sourceEventId: string;
  readonly phase: ExecutionPhase;
  readonly at: string;
  /** Required only for an independently confirmed delivery. */
  readonly observedDeliveryId?: string;
}

export type ExecutionReceipt = ExecutionReceiptInput & { readonly receiptId: string };

type ReceiptDelivery = "pending" | "unknown" | "accepted";
interface JournalEntry {
  /** Monotonically increasing, durable consumption cursor. */
  cursor: number;
  receipt: ExecutionReceipt;
  delivery: ReceiptDelivery;
  externalReceiptId: string | null;
}
interface JournalState {
  version: 1;
  nextCursor: number;
  entries: JournalEntry[];
}
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const MAX_ENTRIES = 20_000;
const journalKey = (namespace: string) => `t3:openrig:execution-receipts:v1:${namespace}`;

function requireId(value: string, label: string): string {
  if (!value || !value.trim() || value.length > 512) throw new Error(`Invalid ${label}.`);
  return value;
}

/** Reject all unverified seat bindings: session role, title, and parent are not authority. */
export function toVerifiedExecutionReceipt(
  input: ExecutionReceiptInput,
  verifiedSeatIds: ReadonlySet<string>,
): ExecutionReceipt {
  requireId(input.seatId, "seatId");
  if (!verifiedSeatIds.has(input.seatId)) throw new Error("OpenRig seat binding is unverified.");
  requireId(input.origin.environmentId, "environmentId");
  requireId(input.origin.generation, "generation");
  requireId(input.sourceEventId, "sourceEventId");
  if (!Number.isFinite(Date.parse(input.at))) throw new Error("Invalid receipt timestamp.");
  if (input.origin.kind === "native") requireId(input.origin.threadId, "threadId");
  else {
    requireId(input.origin.browserSessionId, "browserSessionId");
    // Browser generation and conversation ID are both checked, never inferred from title.
    requireId(input.origin.conversationId, "conversationId");
  }
  if (input.phase === "delivery-observed" && !input.observedDeliveryId?.trim())
    throw new Error("Delivery-observed requires a separately observed delivery receipt ID.");
  if (input.phase !== "delivery-observed" && input.observedDeliveryId !== undefined)
    throw new Error("Only delivery-observed may carry delivery proof.");
  const receiptId = JSON.stringify([
    "t3-openrig-execution-v1",
    input.seatId,
    input.origin.kind,
    input.origin.environmentId,
    input.origin.kind === "native" ? input.origin.threadId : input.origin.browserSessionId,
    input.origin.kind === "chatgpt" ? input.origin.conversationId : null,
    input.origin.generation,
    input.sourceEventId,
    input.phase,
  ]);
  return { ...input, receiptId };
}

/**
 * Durable pending/UNKNOWN journal; a duplicate source receipt never creates a
 * second event, even after OpenRig accepts it. There is deliberately no reset,
 * expiration or assumed retry of UNKNOWN sends.
 */
export class OpenRigExecutionReceiptJournal {
  private readonly key: string;
  private readonly storage: KeyValueStorage;
  constructor(storage: KeyValueStorage, namespace: string) {
    this.storage = storage;
    this.key = journalKey(requireId(namespace, "journal namespace"));
  }
  private read(): JournalState {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return { version: 1, nextCursor: 1, entries: [] };
    const data: unknown = JSON.parse(raw);
    if (
      !data ||
      typeof data !== "object" ||
      (data as JournalState).version !== 1 ||
      !Number.isSafeInteger((data as JournalState).nextCursor) ||
      (data as JournalState).nextCursor < 1 ||
      !Array.isArray((data as JournalState).entries)
    )
      throw new Error("Invalid OpenRig receipt journal; refusing to overwrite.");
    return data as JournalState;
  }
  private persist(state: JournalState): void {
    const value = JSON.stringify(state);
    this.storage.setItem(this.key, value);
    if (this.storage.getItem(this.key) !== value)
      throw new Error("OpenRig receipt journal was not durably written.");
  }
  append(receipt: ExecutionReceipt): boolean {
    const state = this.read();
    const previous = state.entries.find((entry) => entry.receipt.receiptId === receipt.receiptId);
    if (previous) {
      if (JSON.stringify(previous.receipt) !== JSON.stringify(receipt))
        throw new Error("Conflicting source receipt identity; refusing duplicate.");
      return false;
    }
    if (state.entries.length >= MAX_ENTRIES)
      throw new Error("OpenRig receipt journal full; refusing to evict unacknowledged evidence.");
    this.persist({
      version: 1,
      nextCursor: state.nextCursor + 1,
      entries: [
        ...state.entries,
        { cursor: state.nextCursor, receipt, delivery: "pending", externalReceiptId: null },
      ],
    });
    return true;
  }
  entries(afterCursor = 0): ReadonlyArray<Readonly<JournalEntry>> {
    return this.read().entries.filter((entry) => entry.cursor > afterCursor);
  }
  /** Mark the external transport result; UNKNOWN must be reconciled, not replayed. */
  markOutcome(
    receiptId: string,
    outcome: "accepted" | "unknown" | "verified-not-observed",
    externalReceiptId?: string,
  ): void {
    const state = this.read();
    const entry = state.entries.find((candidate) => candidate.receipt.receiptId === receiptId);
    if (!entry) throw new Error("Unknown execution receipt identity.");
    if (entry.delivery === "accepted") {
      if (outcome !== "accepted" || externalReceiptId !== entry.externalReceiptId)
        throw new Error("Cannot revert an accepted OpenRig receipt.");
      return;
    }
    if (outcome === "accepted" && !externalReceiptId?.trim())
      throw new Error("OpenRig acceptance requires a confirmed external receipt ID.");
    const delivery: ReceiptDelivery = outcome === "verified-not-observed" ? "pending" : outcome;
    this.persist({
      version: 1,
      nextCursor: state.nextCursor,
      entries: state.entries.map((candidate) =>
        candidate.receipt.receiptId === receiptId
          ? {
              ...candidate,
              delivery,
              externalReceiptId: outcome === "accepted" ? externalReceiptId! : null,
            }
          : candidate,
      ),
    });
  }
  /** No automatic sending or blind retries. Transport only consumes pending entries. */
  pending(): readonly ExecutionReceipt[] {
    return this.entries()
      .filter((entry) => entry.delivery === "pending")
      .map((entry) => entry.receipt);
  }
  /** Resolve uncertain delivery only from an authoritative, exact-ID lookup. */
  async reconcileUnknown(
    receiptId: string,
    lookup: (receipt: ExecutionReceipt) => Promise<
      | { kind: "accepted"; externalReceiptId: string }
      | { kind: "verified-not-observed" }
      | { kind: "inconclusive" }
    >,
  ): Promise<"accepted" | "pending" | "unknown"> {
    const entry = this.entries().find((candidate) => candidate.receipt.receiptId === receiptId);
    if (!entry || entry.delivery !== "unknown")
      throw new Error("Only UNKNOWN execution receipts can be reconciled.");
    const result = await lookup(entry.receipt);
    if (result.kind === "inconclusive") return "unknown";
    if (result.kind === "accepted") {
      this.markOutcome(receiptId, "accepted", result.externalReceiptId);
      return "accepted";
    }
    this.markOutcome(receiptId, "verified-not-observed");
    return "pending";
  }  unknown(): readonly ExecutionReceipt[] {
    return this.entries()
      .filter((entry) => entry.delivery === "unknown")
      .map((entry) => entry.receipt);
  }
}

/**
 * Transport seam for an authenticated OpenRig receipt-ingest endpoint. The
 * transport MUST deduplicate by receiptId and return a durable external ack.
 * Uncertain transport outcomes are quarantined, never blindly resent here.
 */
export type OpenRigReceiptSendResult =
  | { kind: "accepted"; externalReceiptId: string }
  | { kind: "not-submitted" }
  | { kind: "unknown" };

const activeDrains = new Set<string>();
export async function drainOpenRigExecutionReceipts(
  journal: OpenRigExecutionReceiptJournal,
  drainId: string,
  send: (receipt: ExecutionReceipt) => Promise<OpenRigReceiptSendResult>,
): Promise<readonly { receiptId: string; outcome: OpenRigReceiptSendResult["kind"] }[]> {
  // Single active drain per source in this process. OpenRig still provides
  // canonical cross-process idempotence by exact durable receiptId.
  requireId(drainId, "drainId");
  if (activeDrains.has(drainId)) throw new Error("OpenRig receipt drain already active.");
  activeDrains.add(drainId);
  const outcomes: { receiptId: string; outcome: OpenRigReceiptSendResult["kind"] }[] = [];
  try {
    for (const receipt of journal.pending()) {
      let result: OpenRigReceiptSendResult;
      try {
        result = await send(receipt);
      } catch {
        // A transport exception might occur after remote acceptance.
        result = { kind: "unknown" };
      }
      if (result.kind === "accepted")
        journal.markOutcome(receipt.receiptId, "accepted", result.externalReceiptId);
      else if (result.kind === "unknown") journal.markOutcome(receipt.receiptId, "unknown");
      outcomes.push({ receiptId: receipt.receiptId, outcome: result.kind });
      if (result.kind !== "accepted") break;
    }
    return outcomes;
  } finally {
    activeDrains.delete(drainId);
  }
}

/** No network retry here: failed/ambiguous posts become UNKNOWN in the journal. */
export function openRigHttpReceiptTransport(
  endpoint: string,
  bearerToken: string,
  request: typeof fetch = fetch,
): (receipt: ExecutionReceipt) => Promise<OpenRigReceiptSendResult> {
  return async receipt => {
    const result = await request(`${endpoint.replace(/\/$/, "")}/execution-receipts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` },
      body: JSON.stringify(receipt),
    });
    if (!result.ok) return { kind: "unknown" };
    const body: unknown = await result.json();
    if (!body || typeof body !== "object" || (body as { accepted?: unknown }).accepted !== true ||
      typeof (body as { externalReceiptId?: unknown }).externalReceiptId !== "string")
      return { kind: "unknown" };
    return { kind: "accepted", externalReceiptId: (body as { externalReceiptId: string }).externalReceiptId };
  };
}
/** Exact-ID read for quarantined UNKNOWN receipts; transport errors remain inconclusive. */
export function openRigHttpReceiptLookup(
  endpoint: string,
  bearerToken: string,
  request: typeof fetch = fetch,
): (receipt: ExecutionReceipt) => Promise<
  { kind: "accepted"; externalReceiptId: string } |
  { kind: "verified-not-observed" } | { kind: "inconclusive" }
> {
  return async receipt => {
    try {
      const result = await request(
        `${endpoint.replace(/\/$/, "")}/execution-receipts/${encodeURIComponent(receipt.receiptId)}`,
        { headers: { authorization: `Bearer ${bearerToken}` } },
      );
      if (!result.ok) return { kind: "inconclusive" };
      const body: unknown = await result.json();
      if (!body || typeof body !== "object") return { kind: "inconclusive" };
      const observed = body as { kind?: unknown; externalReceiptId?: unknown };
      if (observed.kind === "accepted" && observed.externalReceiptId === receipt.receiptId)
        return { kind: "accepted", externalReceiptId: receipt.receiptId };
      if (observed.kind === "verified-not-observed") return { kind: "verified-not-observed" };
      return { kind: "inconclusive" };
    } catch { return { kind: "inconclusive" }; }
  };
}