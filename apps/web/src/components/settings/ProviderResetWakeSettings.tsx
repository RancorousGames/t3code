import {
  ThreadId,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ProviderResetWakeup,
  type ServerProvider,
  type ProjectId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { buildThreadRouteParams } from "../../threadRoutes";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useScopedSettings } from "./useScopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";

type ProjectOption = { readonly id: ProjectId; readonly label: string };

function WakeupProviderRow({
  provider,
  projects,
  config,
  save,
  environmentId,
}: {
  environmentId: EnvironmentId | null;
  provider: ServerProvider;
  projects: readonly ProjectOption[];
  config: ProviderResetWakeup | undefined;
  save: (id: string, config: ProviderResetWakeup) => void;
}) {
  const navigate = useNavigate();
  const testThreadId = config?.lastTestResult?.threadId;
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const isPrimary = provider.instanceId === defaultInstanceIdForDriver(provider.driver);
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const selectedProject = projects.find(
    (project) => project.id === (projectChoice ?? config?.projectId),
  );
  const fallbackProject = selectedProject ?? projects[0];
  const models = provider.models.filter((item) => !item.isLegacy);
  const nextReset = provider.usageLimits?.windows.find(
    (window) =>
      window.windowDurationMins === 300 ||
      (provider.driver === "claudeAgent" && window.id === "five_hour"),
  )?.resetsAt;
  const base = (): ProviderResetWakeup | null =>
    fallbackProject
      ? {
          enabled: config?.enabled ?? false,
          projectId: fallbackProject.id,
          ...(config?.armedResetAt ? { armedResetAt: config.armedResetAt } : {}),
          ...(config?.lastTriggeredResetAt
            ? { lastTriggeredResetAt: config.lastTriggeredResetAt }
            : {}),
          ...(config?.queued ? { queued: config.queued } : {}),
          ...(config?.testRequestedAt ? { testRequestedAt: config.testRequestedAt } : {}),
          ...(config?.lastTestResult ? { lastTestResult: config.lastTestResult } : {}),
        }
      : null;

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {provider.displayName ?? provider.driver}
          {isPrimary ? (
            <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
              Main account
            </span>
          ) : (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              Additional account
            </span>
          )}
        </span>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Wake at each 5-hour reset
          <Switch
            aria-label={`Wake ${provider.displayName ?? provider.driver} at 5-hour reset`}
            checked={config?.enabled === true}
            disabled={!fallbackProject}
            onCheckedChange={(enabled) => {
              const current = base();
              if (current) {
                const { armedResetAt: _previousReset, ...rest } = current;
                save(provider.instanceId, {
                  ...rest,
                  enabled: Boolean(enabled),
                  // Never revive an obsolete wake after toggling off and on.
                  ...(enabled && nextReset && Date.parse(nextReset) > Date.now()
                    ? { armedResetAt: nextReset }
                    : {}),
                });
              }
            }}
          />
        </label>
      </div>
      {provider.auth.status === "unauthenticated" ? (
        <p className="text-xs text-warning">
          This provider reports that it is not signed in. Test threads may be created, but the agent
          may not be able to reply until you authenticate this account.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Workspace</span>
        <Select
          value={fallbackProject?.id ?? ""}
          onValueChange={(value) => {
            setProjectChoice(value);
            const current = base();
            const chosen = projects.find((project) => project.id === value);
            if (current && chosen) save(provider.instanceId, { ...current, projectId: chosen.id });
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={`Wake workspace for ${provider.displayName ?? provider.driver}`}
          >
            <SelectValue>{fallbackProject?.label ?? "No project available"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <span className="text-xs text-muted-foreground">
          {config?.armedResetAt
            ? `Armed: ${new Date(config.armedResetAt).toLocaleString()}`
            : nextReset
              ? `Next reset: ${new Date(nextReset).toLocaleString()}`
              : "No 5-hour reset reported yet"}
        </span>
      </div>
      <div className="space-y-1">
        <span className="text-xs text-muted-foreground">
          Optional work to run at the next reset (supersedes hello)
        </span>
        <Textarea
          size="sm"
          aria-label={`Queue next-reset message for ${provider.displayName ?? provider.driver}`}
          placeholder={config?.queued?.text ?? "Leave empty to send a brief hello instead"}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={model || "__auto__"}
            onValueChange={(value) => setModel(value === "__auto__" ? "" : (value ?? ""))}
          >
            <SelectTrigger size="sm" aria-label="Queued job model">
              <SelectValue>
                {model
                  ? (models.find((item) => item.slug === model)?.name ?? model)
                  : "Cheapest available"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="__auto__">Cheapest available</SelectItem>
              {models.map((item) => (
                <SelectItem key={item.slug} value={item.slug}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="xs"
            variant="outline"
            disabled={!prompt.trim() || !fallbackProject}
            onClick={() => {
              const current = base();
              if (current) {
                save(provider.instanceId, {
                  ...current,
                  enabled: true,
                  queued: { text: prompt.trim(), ...(model ? { model } : {}) },
                  ...(current.armedResetAt
                    ? { armedResetAt: current.armedResetAt }
                    : nextReset && Date.parse(nextReset) > Date.now()
                      ? { armedResetAt: nextReset }
                      : {}),
                });
                setPrompt("");
              }
            }}
          >
            Queue next reset
          </Button>
          {config?.queued ? (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                const current = base();
                if (current) {
                  const { queued: _queued, ...rest } = current;
                  save(provider.instanceId, rest);
                }
              }}
            >
              Cancel queued job
            </Button>
          ) : null}
          {config?.queued ? (
            <span className="text-xs text-warning">Custom message queued</span>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={!fallbackProject || config?.testRequestedAt !== undefined}
            onClick={() => {
              const current = base();
              if (current) {
                const { lastTestResult: _previous, ...rest } = current;
                save(provider.instanceId, {
                  ...rest,
                  testRequestedAt: new Date().toISOString(),
                });
              }
            }}
          >
            {config?.testRequestedAt ? "Test pending" : "Send test hello now"}
          </Button>
          {config?.lastTestResult && !config.testRequestedAt ? (
            <span
              role="status"
              className={
                config.lastTestResult.status === "failed"
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {config.lastTestResult.message}
            </span>
          ) : null}
          {testThreadId && environmentId ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(
                    scopeThreadRef(environmentId, ThreadId.make(testThreadId)),
                  ),
                })
              }
            >
              Open test thread
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Server-persisted: survives a closed client, app restart, or overnight startup. */
export function ProviderResetWakeSettings() {
  const { target } = useSettingsScope();
  const settings = useScopedSettings();
  const [showAdditionalAccounts, setShowAdditionalAccounts] = useState(false);
  const { environments } = useEnvironments();
  const projects = useProjects().filter(
    (project) => project.environmentId === target?.environmentId,
  );
  const projectOptions = projects.map((project) => ({
    id: project.id,
    label: project.title,
  }));
  const presentation = environments.find(
    (environment) => environment.environmentId === target?.environmentId,
  );
  const providers = (presentation?.serverConfig?.providers ?? []).filter(
    (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
  );
  // Built-in instance ids (codex / claudeAgent) are the main accounts.
  // Secondary accounts must never be the first or only visible wake targets.
  const mainProviders = providers.filter(
    (provider) => provider.instanceId === defaultInstanceIdForDriver(provider.driver),
  );
  const additionalProviders = providers.filter(
    (provider) => provider.instanceId !== defaultInstanceIdForDriver(provider.driver),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const save = (instanceId: string, config: ProviderResetWakeup) => {
    if (!target) return;
    void update({
      environmentId: target.environmentId,
      input: { patch: { providerResetWakeups: { [instanceId]: config } } },
    });
  };
  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        Start each new 5-hour usage window with a low-cost hello, or run a queued message instead.
        Requires a reported reset time and a saved workspace. Due wakeups are checked when T3
        starts.
      </div>
      {mainProviders.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          No main Codex or Claude account is available in this environment.
        </span>
      ) : (
        mainProviders.map((provider) => (
          <WakeupProviderRow
            key={provider.instanceId}
            environmentId={target?.environmentId ?? null}
            provider={provider}
            projects={projectOptions}
            config={settings.providerResetWakeups[provider.instanceId]}
            save={save}
          />
        ))
      )}
      {additionalProviders.length > 0 ? (
        <div className="space-y-2">
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => setShowAdditionalAccounts((current) => !current)}
          >
            {showAdditionalAccounts ? "Hide" : "Show"} additional provider accounts (
            {additionalProviders.length})
          </Button>
          {showAdditionalAccounts ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Secondary accounts are optional and have independent quotas. Wakeups for them must
                be explicitly enabled.
              </p>
              {additionalProviders.map((provider) => (
                <WakeupProviderRow
                  key={provider.instanceId}
                  environmentId={target?.environmentId ?? null}
                  provider={provider}
                  projects={projectOptions}
                  config={settings.providerResetWakeups[provider.instanceId]}
                  save={save}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
