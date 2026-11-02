import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const ingestChatGPTTranscript = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-transcript:ingest",
  tag: WS_METHODS.chatGptTranscriptIngest,
});
export const readChatGPTTranscript = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-transcript:read",
  tag: WS_METHODS.chatGptTranscriptRead,
});
export const searchChatGPTTranscript = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-transcript:search",
  tag: WS_METHODS.chatGptTranscriptSearch,
});
