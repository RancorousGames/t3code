export type RefreshReceipt = {
  operationId: string;
  sessionId: string;
  priorConversationId: string;
  priorUrl: string;
  generation: number;
  bootstrapHash: string;
  status: "unknown" | "submitted" | "committed" | "restored";
  successorConversationId?: string;
  sendStarted?: boolean;
  historyRestoreIssued?: boolean;
};

export interface RefreshPorts {
  read(): RefreshReceipt[];
  write(receipts: RefreshReceipt[]): void;
  assertSafe(conversationId: string | null): Promise<void>;
  navigate(url: string): Promise<void>;
  send(): Promise<void>;
  observe(): Promise<{
    conversationId: string | null;
    bootstrapHash: string | null;
    assistantReplied: boolean;
  }>;
}

/** The intent is durable before navigation. Repeated begin/status calls only
 * observe; an ambiguous navigation or submit is never replayed. */
export async function refreshSameBrowser(
  input: {
    operationId: string;
    sessionId: string;
    priorConversationId: string;
    bootstrapHash: string;
  },
  phase: "begin" | "status" | "restore" | "finalize",
  ports: RefreshPorts,
): Promise<RefreshReceipt> {
  let receipts = ports.read();
  let receipt = receipts.find((r) => r.operationId === input.operationId);
  if (
    receipt &&
    (receipt.sessionId !== input.sessionId ||
      receipt.priorConversationId !== input.priorConversationId ||
      receipt.bootstrapHash !== input.bootstrapHash)
  )
    throw new Error("Refresh operation ID reused with different inputs.");
  const save = (value: RefreshReceipt) => {
    const fresh = ports.read();
    const previous = fresh.find((r) => r.operationId === input.operationId);
    if (JSON.stringify(previous) !== JSON.stringify(receipt))
      throw new Error("Refresh receipt changed concurrently.");
    const next = previous
      ? fresh.map((r) => (r.operationId === value.operationId ? value : r))
      : [...fresh, value];
    ports.write(next);
    if (JSON.stringify(ports.read()) !== JSON.stringify(next))
      throw new Error("Refresh receipt persistence unconfirmed; no further action.");
    receipt = value;
  };
  if (!receipt) {
    if (phase !== "begin") throw new Error("Unknown refresh operation.");
    if (
      receipts.some(
        (r) => r.sessionId === input.sessionId && !["committed", "restored"].includes(r.status),
      )
    )
      throw new Error("Another refresh is unresolved in this browser.");
    await ports.assertSafe(input.priorConversationId);
    receipts = ports.read();
    if (
      receipts.some(
        (r) => r.sessionId === input.sessionId && !["committed", "restored"].includes(r.status),
      )
    )
      throw new Error("Concurrent refresh reserved this browser.");
    save({
      ...input,
      priorUrl: `https://chatgpt.com/c/${input.priorConversationId}`,
      generation:
        1 +
        Math.max(
          0,
          ...receipts.filter((r) => r.sessionId === input.sessionId).map((r) => r.generation),
        ),
      status: "unknown",
    });
    // Every failure below retains the intent and old canonical URL for recovery.
    // A second safety check covers changes during backup and durable persistence.
    await ports.assertSafe(input.priorConversationId);
    await ports.navigate("https://chatgpt.com/");
    save({ ...receipt!, sendStarted: true });
    await ports.send();
  }
  if (!receipt) throw new Error("Refresh intent missing.");
  if (receipt.status === "restored") return receipt;
  if (receipt.status === "committed") {
    if (phase === "restore" && !receipt.historyRestoreIssued) {
      if (!receipt.successorConversationId)
        throw new Error("Committed generation identity missing.");
      await ports.assertSafe(receipt.successorConversationId);
      save({ ...receipt, historyRestoreIssued: true });
      await ports.assertSafe(receipt.successorConversationId);
      await ports.navigate(receipt.priorUrl);
    }
    return receipt!;
  }
  if (phase === "restore") {
    if (receipt.sendStarted)
      throw new Error("Submit may have started; preserve and reconcile, never navigate back.");
    // Restore only a verified empty home or the unchanged predecessor. Never
    // navigate away from a new conversation, a typed draft or an UNKNOWN send.
    const observed = await ports.observe();
    if (observed.conversationId && observed.conversationId !== receipt.priorConversationId)
      throw new Error("New conversation exists; preserve it and reconcile instead.");
    await ports.assertSafe(observed.conversationId);
    if (!observed.conversationId) await ports.navigate(receipt.priorUrl);
    save({ ...receipt, status: "restored" });
    return receipt!;
  }
  const observed = await ports.observe();
  if (
    !observed.conversationId ||
    observed.conversationId === receipt.priorConversationId ||
    observed.bootstrapHash !== receipt.bootstrapHash
  )
    return receipt;
  if (
    receipt.successorConversationId &&
    receipt.successorConversationId !== observed.conversationId
  )
    throw new Error("Refresh successor conversation changed.");
  if (phase === "finalize" && !observed.assistantReplied)
    throw new Error("First assistant response is not verified.");
  save({
    ...receipt,
    successorConversationId: observed.conversationId,
    status: phase === "finalize" ? "committed" : "submitted",
  });
  return receipt!;
}
