import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Read paths never wake guests; all writes use the normal environment-scoped RPC guard. */
export const listChatGPTRegistry = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:chatgpt-registry:list",
  tag: WS_METHODS.chatGptRegistryList,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
export const readChatGPTRegistry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:read", tag: WS_METHODS.chatGptRegistryList,
});
export const getChatGPTRegistrySession = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:chatgpt-registry:get",
  tag: WS_METHODS.chatGptRegistryGet,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
export const registerChatGPTRegistryDriver = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:register-driver", tag: WS_METHODS.chatGptRegistryDriverRegister,
});
export const heartbeatChatGPTRegistryDriver = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:heartbeat", tag: WS_METHODS.chatGptRegistryDriverHeartbeat,
});
export const disconnectChatGPTRegistryDriver = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:disconnect", tag: WS_METHODS.chatGptRegistryDriverDisconnect,
});
export const syncChatGPTRegistry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:sync", tag: WS_METHODS.chatGptRegistrySync,
});
export const patchChatGPTRegistry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:patch", tag: WS_METHODS.chatGptRegistryPatch,
});
export const closeChatGPTRegistry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:close", tag: WS_METHODS.chatGptRegistryClose,
});
export const actChatGPTRegistry = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:act", tag: WS_METHODS.chatGptRegistryAct,
});
export const takeChatGPTRegistryActions = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:take", tag: WS_METHODS.chatGptRegistryTake,
});
export const finishChatGPTRegistryAction = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:finish", tag: WS_METHODS.chatGptRegistryFinish,
});
export const readChatGPTRegistryReceipt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:chatgpt-registry:receipt", tag: WS_METHODS.chatGptRegistryReceipt,
});
