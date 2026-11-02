/** T3-owned queue remains the sender. These calls admit or release work on
 * the ONE OpenRig capacity ledger; a receipt is never proof of model pickup. */
export type CapacityMessageRequest =
  | {
      action: "claim";
      messageId: string;
      sessionId: string;
      conversationId: string | null;
      maxActiveWorkers?: number;
    }
  | {
      action: "status" | "submit" | "uncertain" | "release";
      messageId: string;
      reason?: "assistant_idle_verified" | "pre_submit_aborted";
    };
export type CapacityMessageReceipt = {
  status: "admitted" | "waiting" | "held" | "submitted" | "uncertain" | "released" | "unavailable";
  messageId: string;
  reason?: string;
};
