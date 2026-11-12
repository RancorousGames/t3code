import {
  chatGPTWebviewAutomation,
  registerNativeChatGPTAutomationSession,
} from "../chatGPTWebviewAutomation";
import { CANONICAL_CHATGPT_CONVERSATION_ID } from "../chatGPTConversationIdentity";
import { delegatedChatGPTStopExpression } from "./stopExpression";

export async function stopDelegatedChatGPTGeneration(
  environmentId: string,
  sessionId: string,
  runtimeId: string,
  conversationId: string,
) {
  if (!CANONICAL_CHATGPT_CONVERSATION_ID.test(conversationId))
    throw new Error("A ChatGPT conversation ID is required to stop a delegated turn.");
  registerNativeChatGPTAutomationSession(environmentId, sessionId);
  const stopped = await chatGPTWebviewAutomation.evaluate(runtimeId, {
    expression: delegatedChatGPTStopExpression(conversationId),
  });
  if (stopped !== true) throw new Error("The delegated ChatGPT Stop control is unavailable.");
  return { stopped: true };
}
