import { DEFAULT_SERVER_SETTINGS, type ModelSelection } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { FilePlus2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { executeProviderBrowserCreate } from "../agentProviderBrowserCreate";
import { useChatGPTBrowserSessions } from "../chatGPTBrowserSessions";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs, waitForThreadShell } from "../state/entities";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { threadEnvironment } from "../state/threads";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useClientSettings, mergeEnvironmentSettings } from "../hooks/useSettings";
import { newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../providerInstances";
import {
  buildPrepfileHandoffInstruction,
  buildPrepfileInstruction,
  prepfileOutputPath,
  readPrepfileHandoffs,
  setPrepfileHandoffs,
  updatePrepfileHandoff,
  type PendingPrepfileHandoff,
  type PrepfileDepth,
} from "../prepfileFlow";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type Generator = "chatgpt" | "luna" | "haiku";
// Preparation is intentionally limited to low-cost models. The full native
// model picker below belongs to the separate implementation agent.
const GENERATORS: ReadonlyArray<{ id: Exclude<Generator, "chatgpt">; label: string; match: RegExp }> = [
  { id: "luna", label: "Luna (native)", match: /\bluna\b/i },
  { id: "haiku", label: "Haiku (native)", match: /\bhaiku\b/i },
];
const isExpensiveImplementationModel = (name: string) =>
  /\b(?:opus|sonnet|gpt[- ]?6|o3|o4|pro)\b/i.test(name) &&
  !/\b(?:haiku|luna|mini|nano|flash|lite)\b/i.test(name);

const failedMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function NewPrepfileAction() {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const { createSession } = useChatGPTBrowserSessions(environmentId);
  const projects = useProjects();
  const configs = useServerConfigs();
  const providerMap = useEnvironmentProviders();
  const clientSettings = useClientSettings();
  const { defaultProjectRef, activeThread, activeDraftThread } = useHandleNewThread();
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [depth, setDepth] = useState<PrepfileDepth>("medium");
  const [generator, setGenerator] = useState<Generator>("chatgpt");
  const [projectChoice, setProjectChoice] = useState("");
  const [autoHandoff, setAutoHandoff] = useState(true);
  const [handoffSelection, setHandoffSelection] = useState<ModelSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, refreshPending] = useState(0);
  const submitting = useRef(false);
  const observedFiles = useRef(new Map<string, string>());
  const handoffRunning = useRef(false);

  const environmentProjects = projects.filter((project) =>
    project.environmentId === environmentId && project.archivedAt == null && !project.isScratch
  );
  const currentProjectId =
    activeThread?.environmentId === environmentId
      ? activeThread.projectId
      : activeDraftThread?.environmentId === environmentId
        ? activeDraftThread.projectId
        : defaultProjectRef?.environmentId === environmentId
          ? defaultProjectRef.projectId
          : null;
  const projectId = projectChoice === "none" ? "" : projectChoice || currentProjectId || environmentProjects[0]?.id || "";
  const project = environmentProjects.find((item) => item.id === projectId) ?? null;
  const providers = environmentId ? providerMap.get(environmentId) ?? [] : [];
  const config = environmentId ? configs.get(environmentId) : null;
  const settings = mergeEnvironmentSettings(config?.settings ?? DEFAULT_SERVER_SETTINGS, clientSettings);
  const instanceEntries = providerInstanceEntriesFor(providers, settings, project?.id ?? null);
  const availableModels = instanceEntries.filter(isProviderInstancePickerReady).flatMap((entry) =>
    entry.models.map((model) => ({
      entry,
      model: model.slug,
      label: model.name,
    }))
  );
  const resolveGenerator = (kind: Generator): ModelSelection | null => {
    const match = GENERATORS.find((item) => item.id === kind)?.match;
    if (!match) return null;
    const available = availableModels.find((item) => match.test(item.model) || match.test(item.label));
    return available ? { instanceId: available.entry.instanceId, model: available.model } : null;
  };
  const preferredImplementationModel = availableModels.find((item) =>
    isExpensiveImplementationModel(item.model) || isExpensiveImplementationModel(item.label)
  );
  const defaultModel = instanceEntries.find(isProviderInstancePickerReady);
  const effectiveHandoff = handoffSelection &&
    instanceEntries.some((item) =>
      item.instanceId === handoffSelection.instanceId && isProviderInstancePickerReady(item) &&
      item.models.some((model) => model.slug === handoffSelection.model)
    )
      ? handoffSelection
      : preferredImplementationModel
        ? { instanceId: preferredImplementationModel.entry.instanceId, model: preferredImplementationModel.model }
        : defaultModel
          ? {
              instanceId: defaultModel.instanceId,
              model: defaultModel.models.find((item) => item.isDefault)?.slug ??
                defaultModel.models[0]?.slug ?? "",
            }
          : null;
  const modelOptions = getCustomModelOptionsByInstance(
    settings, providers, effectiveHandoff?.instanceId, effectiveHandoff?.model,
  );

  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });

  async function startNative(input: {
    environmentId: NonNullable<typeof environmentId>;
    projectId: NonNullable<typeof project>["id"];
    title: string;
    prompt: string;
    modelSelection: ModelSelection;
    threadId?: ReturnType<typeof newThreadId>;
  }) {
    const threadId = input.threadId ?? newThreadId();
    const created = await createThread({
      environmentId: input.environmentId,
      input: {
        threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      },
    });
    if (created._tag === "Failure") throw squashAtomCommandFailure(created);
    if (!(await waitForThreadShell(scopeThreadRef(input.environmentId, threadId)))) {
      throw new Error("Thread was created but did not become visible. Check the session list before retrying.");
    }
    const started = await startTurn({
      environmentId: input.environmentId,
      input: {
        threadId,
        message: { messageId: newMessageId(), role: "user", text: input.prompt, attachments: [] },
        modelSelection: input.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        dispatchMode: "queue",
      },
    });
    if (started._tag === "Failure") {
      throw new Error(`Thread ${threadId} was created, but its first message was rejected: ${failedMessage(squashAtomCommandFailure(started))}. Do not launch the same request again without inspecting this thread.`);
    }
    return threadId;
  }

  const dispatchHandoff = useEffectEvent(async (job: PendingPrepfileHandoff) => {
    try {
      const threadId = await startNative({
        environmentId: job.environmentId,
        projectId: job.projectId,
        title: "Implement prepared task",
        prompt: buildPrepfileHandoffInstruction(job),
        modelSelection: job.modelSelection,
        ...(job.targetThreadId ? { threadId: job.targetThreadId } : {}),
      });
      updatePrepfileHandoff(job.id, () => null);
      refreshPending((value) => value + 1);
      toastManager.add({
        type: "success",
        title: "Prepfile handed over",
        description: `New implementation thread ${threadId} is running.`,
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Prepfile handoff needs review",
        description: `${failedMessage(cause)} Auto-retry is disabled to prevent duplicate sessions.`,
      });
    }
  });

  useEffect(() => {
    const checkFile = window.desktopBridge?.readPrepfileStatus;
    if (!environmentId || !checkFile) return;
    let cancelled = false;
    const check = async () => {
      if (handoffRunning.current || cancelled) return;
      handoffRunning.current = true;
      try {
        for (const job of readPrepfileHandoffs()) {
          if (cancelled || job.environmentId !== environmentId || job.state !== "waiting") continue;
          if (Date.now() - job.createdAt > 72 * 3_600_000) {
            updatePrepfileHandoff(job.id, () => null);
            refreshPending((value) => value + 1);
            continue;
          }
          const file = await checkFile(job.outputPath);
          if (!file.exists || file.size < 64 || Date.now() - file.modifiedAtMs < 3_000) {
            observedFiles.current.delete(job.id);
            continue;
          }
          const fingerprint = `${file.size}:${file.modifiedAtMs}`;
          if (observedFiles.current.get(job.id) !== fingerprint) {
            observedFiles.current.set(job.id, fingerprint);
            continue;
          }
          // Durable, single-shot dispatch guard: an uncertain creation is never replayed.
          if (cancelled) return;
          const targetThreadId = newThreadId();
          updatePrepfileHandoff(job.id, (entry) => ({ ...entry, state: "dispatching", targetThreadId }));
          refreshPending((value) => value + 1);
          await dispatchHandoff({ ...job, state: "dispatching", targetThreadId });
        }
      } catch (cause) {
        toastManager.add({ type: "error", title: "Prepfile monitoring failed", description: failedMessage(cause) });
      } finally {
        handoffRunning.current = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [environmentId]);

  const submit = async () => {
    if (submitting.current || !environmentId || !request.trim()) return;
    if (!project && generator !== "chatgpt") {
      setError("Choose a project before starting a native prepfile agent.");
      return;
    }
    if (autoHandoff && (!project || !effectiveHandoff?.model)) {
      setError("Choose a project and an available handoff model.");
      return;
    }
    const generatorSelection = generator === "chatgpt" ? null : resolveGenerator(generator);
    if (generator !== "chatgpt" && !generatorSelection) {
      setError("The selected generator model is not available in this project.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    const id = randomUUID();
    const outputPath = prepfileOutputPath(id, request, project?.title ?? null);
    const prompt = buildPrepfileInstruction({
      request: request.trim(), outputPath, depth, hasAutomaticHandoff: autoHandoff,
    });
    const job: PendingPrepfileHandoff | null = autoHandoff && project && effectiveHandoff
      ? {
          id, environmentId, projectId: project.id,
          modelSelection: effectiveHandoff,
          outputPath, request: request.trim(), createdAt: Date.now(), state: "waiting",
        }
      : null;
    try {
      if (job) setPrepfileHandoffs([...readPrepfileHandoffs(), job]);
      if (generator === "chatgpt") {
        const outcome = await executeProviderBrowserCreate(
          environmentId,
          {
            action: "create",
            jobId: id,
            environmentId,
            clientRequestId: id,
            title: "Prepare context file",
            prompt,
            ...(project ? { project: project.title } : {}),
          },
          createSession,
        );
        if (!outcome.ok) throw new Error(outcome.message);
        if (!outcome.data.created) {
          throw new Error(outcome.data.reason ?? "ChatGPT session creation is unconfirmed.");
        }
        if (outcome.data.promptDelivery === "not_sent") {
          throw new Error("ChatGPT session created, but the prepfile instruction was not sent.");
        }
        if (outcome.data.promptDelivery === "unknown") {
          toastManager.add({
            type: "warning",
            title: "Prepfile prompt delivery uncertain",
            description: "Inspect the new ChatGPT session. It will not be submitted twice.",
          });
        }
        await navigate({ to: "/browser/$browserSessionId", params: { browserSessionId: outcome.data.sessionId } });
      } else if (project && generatorSelection) {
        const threadId = await startNative({
          environmentId, projectId: project.id, title: "Prepare context file",
          prompt, modelSelection: generatorSelection,
        });
        await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
      }
      setOpen(false);
      setRequest("");
      toastManager.add({
        type: "success",
        title: autoHandoff ? "Prepfile agent started; handoff armed" : "Prepfile agent started",
        description: autoHandoff
          ? "T3 will start the selected implementation model when the output file is complete."
          : `Expected file: ${outputPath}`,
      });
    } catch (cause) {
      // The first request may have persisted even if its result is uncertain.
      // Keep an armed job rather than invent a safe retry.
      setError(failedMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const pending = open ? readPrepfileHandoffs().filter((job) => job.environmentId === environmentId) : [];
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              className="[-webkit-app-region:no-drag]"
              aria-label="New prepfile"
              onClick={() => { setError(null); setOpen(true); }}
            />
          }
        >
          <FilePlus2Icon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New prepfile</TooltipPopup>
      </Tooltip>
      <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}>
        <DialogPopup className="sm:max-w-xl">
          <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <DialogHeader>
              <DialogTitle>New prepfile</DialogTitle>
              <DialogDescription>
                A cheap preparation agent collects source context; a separate implementation agent can use it without repeating discovery.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-4">
                <Label className="flex flex-col gap-1.5">
                  Details for prepfile
                  <Textarea
                    value={request}
                    required
                    placeholder="Describe the task, paste an issue, or specify what context to collect…"
                    onChange={(event) => setRequest(event.target.value)}
                    className="min-h-32"
                    disabled={busy}
                  />
                </Label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Label className="flex flex-col gap-1.5">
                    Step 1 · Preparation model (cheap)
                    <Select
                      value={generator}
                      items={{ chatgpt: "ChatGPT session", luna: "Luna (native)", haiku: "Haiku (native)" }}
                      onValueChange={(value) => { if (value) setGenerator(value as Generator); }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="chatgpt">ChatGPT session</SelectItem>
                        {GENERATORS.map((item) => (
                          <SelectItem key={item.id} value={item.id} disabled={!resolveGenerator(item.id)}>
                            {item.label}{!resolveGenerator(item.id) ? " — unavailable" : ""}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Label>
                  <Label className="flex flex-col gap-1.5">
                    Context depth
                    <Select value={depth} items={{ light: "Light", medium: "Medium", heavy: "Heavy" }}
                      onValueChange={(value) => { if (value) setDepth(value as PrepfileDepth); }}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="light">Light</SelectItem>
                        <SelectItem value="medium">Medium (default)</SelectItem>
                        <SelectItem value="heavy">Heavy</SelectItem>
                      </SelectPopup>
                    </Select>
                  </Label>
                </div>
                <Label className="flex flex-col gap-1.5">
                  Project / workspace
                  <select
                    className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                    value={projectId}
                    onChange={(event) => setProjectChoice(event.target.value)}
                    disabled={busy}
                  >
                    {generator === "chatgpt" && <option value="none">No project</option>}
                    {environmentProjects.map((item) => (
                      <option key={item.id} value={item.id}>{item.title}</option>
                    ))}
                  </select>
                </Label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={autoHandoff} onCheckedChange={(value) => setAutoHandoff(value === true)} />
                  Start an implementation agent automatically
                </label>
                {autoHandoff && (
                  <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
                    <Label>Step 2 · Implementation model (full native T3 picker)</Label>
                    {effectiveHandoff && environmentId ? (
                      <ProviderModelPicker
                        environmentId={environmentId}
                        activeInstanceId={effectiveHandoff.instanceId}
                        model={effectiveHandoff.model}
                        lockedProvider={null}
                        instanceEntries={instanceEntries}
                        modelOptionsByInstance={modelOptions}
                        triggerLabel="Choose handoff model"
                        onInstanceModelChange={(instanceId, model) =>
                          setHandoffSelection({ instanceId, model })}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">No available native T3 model for this project.</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      When preparation finishes, T3 creates a new implementation thread with this model. No second thread is created if delivery is uncertain.
                    </p>
                  </div>
                )}
                {autoHandoff && pending.length > 0 && (
                  <div className="rounded-lg border border-border p-2 text-xs">
                    <p className="mb-2 font-medium">Pending handoffs</p>
                    {pending.map((job) => (
                      <div key={job.id} className="flex items-center justify-between gap-2 py-1">
                        <span className="min-w-0 truncate" title={job.outputPath}>
                          {job.state === "waiting" ? "Waiting for file" : "Needs reconciliation"} · {job.outputPath.split("\\").at(-1)}
                        </span>
                        <div className="flex shrink-0 gap-1">
                          {job.targetThreadId && <Button type="button" size="xs" variant="ghost" onClick={() => {
                            void navigate({ to: "/$environmentId/$threadId", params: { environmentId: job.environmentId, threadId: job.targetThreadId! } });
                            setOpen(false);
                          }}>Open thread</Button>}
                          <Button type="button" size="xs" variant="ghost" onClick={() => {
                            updatePrepfileHandoff(job.id, () => null);
                            refreshPending((value) => value + 1);
                            setError(null);
                          }}>Dismiss</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={busy || !request.trim() || !environmentId || (autoHandoff && !effectiveHandoff?.model)}>
                {busy ? "Starting…" : "Create prepfile"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
