import type { ManagedMcpServer } from "@t3tools/contracts/settings";

// LOCAL TEMPORARY FEATURE: Delete this bridge when upstream T3 provides its own
// MCP server management and provider integration (pingdotgg/t3code #14118).
export const managedMcpServerKey = (name: string): string => `t3-managed-${name}`;

export function enabledManagedMcpServers(
  servers: ReadonlyArray<ManagedMcpServer>,
  provider: "codex" | "claude",
): ReadonlyArray<ManagedMcpServer> {
  return servers.filter((server) => server.enabled && server.providers.includes(provider));
}
