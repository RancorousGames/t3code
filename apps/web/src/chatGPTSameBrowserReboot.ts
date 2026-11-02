/** ChatGPT displays a collapsed, read-only UI expansion affordance after long user messages.
 * It is NOT part of the submitted prompt and must not invalidate its exact hash.
 * Only this anchored known suffix is removed; arbitrary text remains a mismatch. */
export function normalizeChatGPTRebootBootstrap(text: string): string {
  // Do not trim the submitted text: even a single extra space changes the receipt hash.
  return text.replace(/\n…\nShow more$/, "");
}

export type RebootReceipt = {
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
  supersededBy?: string;
};

export interface RebootPorts {
  read(): RebootReceipt[];
  write(receipts: RebootReceipt[]): void;
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
export async function rebootSameBrowser(
  input: {
    operationId: string;
    sessionId: string;
    priorConversationId: string;
    bootstrapHash: string;
  },
  phase: "begin" | "status" | "restore" | "finalize",
  ports: RebootPorts,
): Promise<RebootReceipt> {
  let receipts = ports.read();
  let receipt = receipts.find((r) => r.operationId === input.operationId);
  if (
    receipt &&
    (receipt.sessionId !== input.sessionId ||
      receipt.priorConversationId !== input.priorConversationId ||
      receipt.bootstrapHash !== input.bootstrapHash)
  )
    throw new Error("Reboot operation ID reused with different inputs.");
  const save = (value: RebootReceipt, supersedeExisting = false) => {
    const fresh = ports.read();
    const previous = fresh.find((r) => r.operationId === input.operationId);
    if (JSON.stringify(previous) !== JSON.stringify(receipt))
      throw new Error("Reboot receipt changed concurrently.");
    const history = supersedeExisting
      ? fresh.map((r) =>
          r.sessionId === input.sessionId &&
          !r.supersededBy &&
          !["committed", "restored"].includes(r.status)
            ? { ...r, supersededBy: input.operationId }
            : r,
        )
      : fresh;
    const next = previous
      ? fresh.map((r) => (r.operationId === value.operationId ? value : r))
      : [...history, value];
    ports.write(next);
    if (JSON.stringify(ports.read()) !== JSON.stringify(next))
      throw new Error("Reboot receipt persistence unconfirmed; no further action.");
    receipt = value;
  };
  if (!receipt) {
    if (phase !== "begin") throw new Error("Unknown reboot operation.");
    await ports.assertSafe(input.priorConversationId);
    receipts = ports.read();
    // A fresh explicit reboot replaces an unresolved generation. Preserve its
    // receipt without allowing later reconciliation to act on the new guest.
    save(
      {
        ...input,
        priorUrl: input.priorConversationId
          ? `https://chatgpt.com/c/${input.priorConversationId}`
          : "https://chatgpt.com/",
        generation:
          1 +
          Math.max(
            0,
            ...receipts.filter((r) => r.sessionId === input.sessionId).map((r) => r.generation),
          ),
        status: "unknown",
      },
      true,
    );
    // Every failure below retains the intent and old canonical URL for recovery.
    // A second safety check covers changes during backup and durable persistence.
    await ports.assertSafe(input.priorConversationId);
    await ports.navigate("https://chatgpt.com/");
    save({ ...receipt!, sendStarted: true });
    await ports.send();
    // send() verifies the new user turn. Reboot is complete at that point;
    // waiting for the assistant to finish is unrelated to replacing the chat.
    save({ ...receipt!, status: "submitted" });
  }
  if (!receipt) throw new Error("Reboot intent missing.");
  if (receipt.supersededBy) return receipt;
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
  // A slow/unavailable page inspector must not turn a confirmed send into a
  // failed reboot. Status/finalize are optional receipt enrichment.
  const observed = await ports.observe().catch(() => null);
  if (!observed) return receipt;
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
    throw new Error("Reboot successor conversation changed.");
  save({
    ...receipt,
    successorConversationId: observed.conversationId,
    status: phase === "finalize" && observed.assistantReplied ? "committed" : "submitted",
  });
  return receipt!;
}
