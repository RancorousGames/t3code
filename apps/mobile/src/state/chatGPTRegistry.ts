import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** All mobile requests use the existing paired-environment authentication. */
export const listChatGPTRegistry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:chatgpt-registry:list",
  tag: WS_METHODS.chatGptRegistryList,
});
export const patchChatGPTRegistry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:chatgpt-registry:patch",
  tag: WS_METHODS.chatGptRegistryPatch,
});
export const actChatGPTRegistry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:chatgpt-registry:act",
  tag: WS_METHODS.chatGptRegistryAct,
});
export const readChatGPTRegistryReceipt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:chatgpt-registry:receipt",
  tag: WS_METHODS.chatGptRegistryReceipt,
});
