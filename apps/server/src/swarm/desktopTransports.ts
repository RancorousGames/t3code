import type { DesktopAppActivationRequest } from "@t3tools/contracts";

/** The only server-side Swarm delivery adapter. Both HTTP and native MCP
 * inject the desktop's EXISTING named-pipe and durable ChatGPT queue. */
export const desktopSwarmTransports = (
  exchange: (request: DesktopAppActivationRequest) => Promise<Record<string, unknown>>,
) => ({
  native: (call: Record<string, unknown>) =>
    exchange({
      version: 1,
      requestId: String(call.clientRequestId),
      type: "t3.threads",
      action: "send",
      threadId: String(call.threadId),
      ...(call.expectedEnvironmentId ? { environmentId: String(call.expectedEnvironmentId) } : {}),
      clientRequestId: String(call.clientRequestId),
      message: String(call.message),
    }),
  chatgpt: (call: Record<string, unknown>) =>
    call.action === "delivery_status"
      ? exchange({
          version: 1,
          requestId: `swarm-delivery-status:${String(call.messageId)}`,
          type: "chatgpt.sessions",
          action: "delivery_status",
          messageId: String(call.messageId),
        })
      : exchange({
          version: 1,
          requestId: String(call.messageId),
          type: "chatgpt.sessions",
          action: "enqueue",
          messageId: String(call.messageId),
          sessionId: String(call.sessionId),
          expectedConversationId: String(call.expectedConversationId),
          message: String(call.message),
        }),
});
