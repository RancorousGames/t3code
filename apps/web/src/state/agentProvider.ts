import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

// The existing environment WS authentication and operation-scope middleware
// apply to the desktop catalog publication just like other RPC commands.
export const agentProviderCall = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment:agent-provider:v1",
  tag: WS_METHODS.agentProviderCall,
});
