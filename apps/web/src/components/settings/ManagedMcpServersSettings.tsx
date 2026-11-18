import { useState } from "react";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import type { ManagedMcpServer } from "@t3tools/contracts/settings";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// LOCAL TEMPORARY FEATURE: Remove this panel, model and provider overrides when
// upstream T3 Code ships native MCP management (pingdotgg/t3code #14118).
// Keep it self-contained so the upstream implementation can replace it cleanly.
export function ManagedMcpServersSettings({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const servers = useEnvironmentSettings(environmentId, (settings) => settings.mcpServers);
  const update = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const writable = !readOnly && canWrite;
  const [editingName, setEditingName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [codex, setCodex] = useState(true);
  const [claude, setClaude] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const clearEditor = () => {
    setEditingName(null);
    setName("");
    setUrl("");
    setCodex(true);
    setClaude(true);
    setError(null);
  };

  const edit = (server: ManagedMcpServer) => {
    setEditingName(server.name);
    setName(server.name);
    setUrl(server.url);
    setCodex(server.providers.includes("codex"));
    setClaude(server.providers.includes("claude"));
    setError(null);
  };

  const save = () => {
    const nextName = name.trim();
    const nextUrl = url.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(nextName)) {
      setError("Name must start with a letter and use up to 48 letters, digits, - or _.");
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(nextUrl);
    } catch {
      setError("Enter a valid HTTP or HTTPS MCP endpoint URL.");
      return;
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      /\s/.test(nextUrl)
    ) {
      setError("Only HTTP(S) URLs without embedded credentials are supported.");
      return;
    }
    const providers: ManagedMcpServer["providers"] = [
      ...(codex ? ["codex" as const] : []),
      ...(claude ? ["claude" as const] : []),
    ];
    if (providers.length === 0) {
      setError("Choose at least one provider.");
      return;
    }
    if (
      servers.some(
        (server) =>
          server.name.toLowerCase() === nextName.toLowerCase() && server.name !== editingName,
      )
    ) {
      setError("An MCP server already uses that name.");
      return;
    }
    if (editingName === null && servers.length >= 24) {
      setError("A maximum of 24 managed MCP servers is supported.");
      return;
    }
    const previous = servers.find((server) => server.name === editingName);
    const entry: ManagedMcpServer = {
      name: nextName,
      url: nextUrl,
      enabled: previous?.enabled ?? true,
      providers,
    };
    update({
      mcpServers:
        editingName === null
          ? [...servers, entry]
          : servers.map((server) => (server.name === editingName ? entry : server)),
    });
    clearEditor();
  };

  return (
    <SettingsSection {...searchableSetting("mcp-servers")}>
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          Manage HTTP MCP servers for native Codex and Claude threads on this device. Configuration
          applies when a provider thread starts or resumes; existing live threads may need to
          restart. Other providers and stdio MCP servers use their own configuration.
        </p>
        {servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">No T3-managed MCP servers yet.</p>
        ) : (
          <div className="divide-y divide-border/50 rounded-md border border-border/60">
            {servers.map((server) => (
              <div key={server.name} className="flex flex-wrap items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{server.name}</div>
                  <div className="truncate text-xs text-muted-foreground" title={server.url}>
                    {server.url}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {server.providers
                      .map((provider) => (provider === "codex" ? "Codex" : "Claude"))
                      .join(" · ")}
                  </div>
                </div>
                <Switch
                  aria-label={`Enable ${server.name}`}
                  checked={server.enabled}
                  disabled={!writable}
                  onCheckedChange={(enabled) =>
                    update({
                      mcpServers: servers.map((entry) =>
                        entry.name === server.name ? { ...entry, enabled } : entry,
                      ),
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost-muted"
                  disabled={!writable}
                  onClick={() => edit(server)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost-muted"
                  disabled={!writable}
                  onClick={() => {
                    update({ mcpServers: servers.filter((entry) => entry.name !== server.name) });
                    if (editingName === server.name) clearEditor();
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
        {writable ? (
          <div className="space-y-2 rounded-md border border-border/60 p-3">
            <div className="text-sm font-medium">
              {editingName === null ? "Add MCP server" : `Edit ${editingName}`}
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(8rem,1fr)_minmax(12rem,2fr)]">
              <Input
                aria-label="MCP server name"
                placeholder="e.g. OMCPT"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Input
                aria-label="MCP server URL"
                placeholder="http://127.0.0.1:8773/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={codex}
                  onChange={(event) => setCodex(event.target.checked)}
                />
                Codex
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={claude}
                  onChange={(event) => setClaude(event.target.checked)}
                />
                Claude
              </label>
            </div>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={save}>
                {editingName === null ? "Add server" : "Save changes"}
              </Button>
              {editingName !== null ? (
                <Button size="sm" variant="ghost-muted" onClick={clearEditor}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
