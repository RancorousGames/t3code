import type { BrowserSession } from "./chatGPTBrowserSessions";

/** The browser may reflow line breaks and spaces in a submitted ChatGPT user turn. */
export function chatGPTSentTurnObserved(
  expected: string,
  messages: readonly { role: string; text: string }[],
  previousTurns: number,
  observedTurns: number,
): boolean {
  if (observedTurns <= previousTurns) return false;
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return messages.some(
    (message) => message.role === "user" && normalize(message.text) === normalize(expected),
  );
}

/**
 * A local named-pipe client may identify a source session, but the pipe does
 * not authenticate which ChatGPT tab invoked it. Keep provenance explicitly
 * caller-reported, never turn forwarded text into a privileged instruction.
 */
export function prepareChatGPTSessionMessage(
  sessions: readonly BrowserSession[],
  recipientId: string,
  message: string,
  senderSessionId?: string,
) {
  const recipient = sessions.find((session) => session.id === recipientId);
  if (!recipient || recipient.hidden) throw new Error("Unknown or hidden recipient session ID.");
  const text = message.trim();
  if (!text) throw new Error("Non-empty message required.");
  if (!senderSessionId) return { recipient, sender: null, text };

  const sender = sessions.find((session) => session.id === senderSessionId);
  if (!sender || sender.hidden) throw new Error("Unknown or hidden sender session ID.");
  if (sender.id === recipient.id) throw new Error("Sender and recipient must differ.");

  return {
    recipient,
    sender,
    text: [
      "T3 local inter-session message (sender ID supplied by caller, not authenticated).",
      `From browser session: ${JSON.stringify(sender.id)}`,
      `To browser session: ${JSON.stringify(recipient.id)}`,
      "To reply, use T3 session control with the sender session ID above.",
      "",
      text,
    ].join("\n"),
  };
}
