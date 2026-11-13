import { DEFAULT_SERVER_SETTINGS, type ModelSelection } from "@t3tools/contracts";
import { isReasoningControl } from "@t3tools/client-runtime/model-traits";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { FilePlus2Icon } from "lucide-react";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { shortcutLabelForCommand } from "../keybindings";
import { registerCommands, registerMenuAction } from "../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { executeProviderBrowserCreate } from "../agentProviderBrowserCreate";
import { useChatGPTBrowserSessions } from "../chatGPTBrowserSessions";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs, waitForThreadShell } from "../state/entities";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { threadEnvironment } from "../state/threads";
import { useScratchProject } from "../hooks/useScratchProject";
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
import { SidebarHeaderIconButton } from "./sidebar/SidebarThreadHeader";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { toastManager } from "./ui/toast";

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
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "prepfile.new");
  const environmentId = usePrimaryEnvironmentId();
  const { createSession } = useChatGPTBrowserSessions(environmentId);
  const projects = useProjects();
  const configs = useServerConfigs();
  const providerMap = useEnvironmentProviders();
  const clientSettings = useClientSettings();
  const { openScratchProject } = useScratchProject();
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [depth, setDepth] = useState<PrepfileDepth>("medium");
  const [generator, setGenerator] = useState<Generator>("chatgpt");
  const [projectChoice, setProjectChoice] = useState("none");
  const [autoHandoff, setAutoHandoff] = useState(true);
  const [createTaskboardTask, setCreateTaskboardTask] = useState(
    () => localStorage.getItem("t3code:prepfile-create-taskboard:v1") === "true",
  );
  const [effortChoice, setEffortChoice] = useState("medium");
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [handoffSelection, setHandoffSelection] = useState<ModelSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, refreshPending] = useState(0);
  const submitting = useRef(false);
  const observedFiles = useRef(new Map<string, string>());
  const handoffRunning = useRef(false);
  const openDialog = useEffectEvent(() => {
    setError(null);
    setOpen(true);
  });

  // The header button, configurable keybinding, and command palette share one dialog.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the desktop prepfile shortcut while mounted
  useEffect(() => {
    const unregisterKeydown = registerCommands(
      {
        "prepfile.new": (event) => {
          if (
            event.repeat ||
            event.isComposing ||
            isCommandPaletteOpen() ||
            (event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
          ) return false;
          event.preventDefault();
          event.stopPropagation();
          openDialog();
          return true;
        },
      },
      { capture: true, keybindings: () => keybindings },
    );
    const unregisterMenuAction = registerMenuAction("prepfile.new", () => {
      if (!isCommandPaletteOpen()) openDialog();
    });
    return () => {
      unregisterKeydown();
      unregisterMenuAction();
    };
  }, [keybindings]);

  const environmentProjects = projects.filter((project) =>
    project.environmentId === environmentId && project.archivedAt == null && !project.isScratch
  );
  const projectId = projectChoice === "none" ? "" : projectChoice;
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
  const selectedEntry = instanceEntries.find((item) => item.instanceId === effectiveHandoff?.instanceId);
  const selectedModel = selectedEntry?.models.find((item) => item.slug === effectiveHandoff?.model);
  const reasoning = selectedModel?.capabilities?.optionDescriptors?.find(
    (item) => item.type === "select" && isReasoningControl(item),
  );
  const effortLevels = (reasoning?.type === "select" ? reasoning.options : []).filter(
    (choice) => ["low", "medium", "high", "xhigh"].includes(choice.id),
  );
  const effectiveEffort = effortLevels.some((choice) => choice.id === effortChoice)
    ? effortChoice
    : effortLevels.find((choice) => choice.id === reasoning?.currentValue)?.id ??
      effortLevels.find((choice) => choice.isDefault)?.id ??
      effortLevels[0]?.id ??
      null;
  const implementationSelection: ModelSelection | null = effectiveHandoff
    ? {
        ...effectiveHandoff,
        ...(reasoning && effectiveEffort
          ? { options: [{ id: reasoning.id, value: effectiveEffort }] }
          : {}),
      }
    : null;

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

  const submit = () => {
    if (submitting.current || !environmentId || !request.trim()) return;
    const generatorSelection = generator === "chatgpt" ? null : resolveGenerator(generator);
    if (generator !== "chatgpt" && !generatorSelection) {
      setError("The selected preparation model is unavailable.");
      return;
    }
    if (autoHandoff && !implementationSelection?.model) {
      setError("Choose an available implementation model.");
      return;
    }
    const captured = {
      environmentId, request: request.trim(), depth, generator,
      generatorSelection, project, autoHandoff, implementationSelection,
      createTaskboardTask, images: [...attachedImages],
    };
    // Close on click. Session creation and prompt delivery can take minutes,
    // and must not hold a user-facing dialog open.
    submitting.current = true;
    setOpen(false);
    requestAnimationFrame(() => { submitting.current = false; });
    setRequest("");
    setAttachedImages([]);
    setError(null);
    void (async () => {
      const id = randomUUID();
      const outputPath = prepfileOutputPath(id, captured.request, captured.project?.title ?? null);
      let targetProject = captured.project;
      if (!targetProject && (captured.generator !== "chatgpt" || captured.autoHandoff)) {
        const scratch = await openScratchProject(captured.environmentId, "Could not open a no-project workspace");
        if (!scratch) throw new Error("Could not create a no-project workspace for the native agent.");
        targetProject = scratch;
      }
      const imagePaths: string[] = [];
      for (const file of captured.images) {
        if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) {
          throw new Error("Attached files must be images of at most 8 MiB.");
        }
        const save = window.desktopBridge?.savePrepfileImage;
        if (!save) throw new Error("Saving pasted images requires the T3 desktop app.");
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("Could not read the pasted image."));
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(file);
        });
        imagePaths.push(await save({ mime: file.type, dataUrl }));
      }
      const prompt = buildPrepfileInstruction({
        request: captured.request, outputPath, depth: captured.depth,
        hasAutomaticHandoff: captured.autoHandoff,
        createTaskboardTask: captured.createTaskboardTask,
        imagePaths,
      });
      const job: PendingPrepfileHandoff | null =
        captured.autoHandoff && targetProject && captured.implementationSelection
          ? {
              id, environmentId: captured.environmentId, projectId: targetProject.id,
              modelSelection: captured.implementationSelection, outputPath,
              request: captured.request, createdAt: Date.now(), state: "waiting",
            }
          : null;
      if (job) setPrepfileHandoffs([...readPrepfileHandoffs(), job]);
      if (captured.generator === "chatgpt") {
        const outcome = await executeProviderBrowserCreate(
          captured.environmentId,
          {
            action: "create", jobId: id, environmentId: captured.environmentId,
            clientRequestId: id, title: "Prepare context file", prompt,
            ...(captured.project ? { project: captured.project.title } : {}),
          },
          createSession,
        );
        if (!outcome.ok) throw new Error(outcome.message);
        if (!outcome.data.created)
          throw new Error(outcome.data.reason ?? "Prepfile session creation is unconfirmed.");
        if (outcome.data.promptDelivery === "not_sent")
          throw new Error("Session created, but the prepfile instruction was not sent. Inspect it before retrying.");
        if (outcome.data.promptDelivery === "unknown") {
          toastManager.add({
            type: "warning", title: "Prepfile prompt delivery uncertain",
            description: "Inspect the new ChatGPT session; the prompt will not be submitted twice.",
          });
        }
      } else if (targetProject && captured.generatorSelection) {
        await startNative({
          environmentId: captured.environmentId, projectId: targetProject.id,
          title: "Prepare context file", prompt, modelSelection: captured.generatorSelection,
        });
      }
      toastManager.add({
        type: "success",
        title: captured.autoHandoff ? "Prepfile started; automatic handoff armed" : "Prepfile started",
        description: "The preparation session is running independently of this dialog.",
      });
    })().catch((cause) => {
      toastManager.add({ type: "error", title: "Prepfile start needs attention", description: failedMessage(cause) });
    });
  };

  const pending = open ? readPrepfileHandoffs().filter((job) => job.environmentId === environmentId) : [];
  return (
    <>
      <SidebarHeaderIconButton
        label="New prepfile"
        tooltip={shortcutLabel ? `New prepfile (${shortcutLabel})` : "New prepfile"}
        onClick={() => openDialog()}
      >
        <FilePlus2Icon />
      </SidebarHeaderIconButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="sm:max-w-xl">
          <form onSubmit={(event) => { event.preventDefault(); submit(); }}
            onPasteCapture={(event) => {
              const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
              if (!files.length) return;
              event.preventDefault();
              setAttachedImages((previous) => [...previous, ...files].slice(0, 8));
            }}
          >
            <DialogHeader>
              <DialogTitle>New prepfile</DialogTitle>
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
                  />
                  <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    Attach images (or Ctrl+V)
                    <input type="file" accept="image/*" multiple className="max-w-32 text-xs"
                      onChange={(event) => {
                        setAttachedImages((previous) => [...previous, ...(event.target.files ?? [])].slice(0, 8));
                        event.target.value = "";
                      }} />
                  </label>
                  {attachedImages.map((image, index) => (
                    <div key={index} className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate">{image.name || ("Pasted image " + (index + 1))} ({Math.round(image.size / 1024)} KiB)</span>
                      <Button type="button" size="xs" variant="ghost" onClick={() => setAttachedImages((previous) => previous.filter((_, i) => i !== index))}>Remove</Button>
                    </div>
                  ))}
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
                    value={projectChoice}
                    onChange={(event) => setProjectChoice(event.target.value)}
                  >
                    <option value="none">No project</option>
                    {environmentProjects.map((item) => (
                      <option key={item.id} value={item.id}>{item.title}</option>
                    ))}
                  </select>
                </Label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={autoHandoff} onCheckedChange={(value) => setAutoHandoff(value === true)} />
                  Start an implementation agent automatically
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox checked={createTaskboardTask} onCheckedChange={(value) => {
                    const enabled = value === true;
                    setCreateTaskboardTask(enabled);
                    localStorage.setItem("t3code:prepfile-create-taskboard:v1", String(enabled));
                  }} />
                  Prepfile writer creates a TaskBoard task
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
                        onInstanceModelChange={(instanceId, model) =>
                          setHandoffSelection({ instanceId, model })}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">No available native T3 model for this project.</p>
                    )}
                    {effectiveHandoff && (
                      <p className="text-xs text-muted-foreground">
                        Selected: {selectedModel?.name ?? effectiveHandoff.model} ({selectedEntry?.displayName ?? effectiveHandoff.instanceId})
                      </p>
                    )}
                    <Label className="flex flex-col gap-1">
                      Implementation effort
                      <select className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
                        value={effectiveEffort ?? ""} disabled={!effortLevels.length}
                        onChange={(event) => setEffortChoice(event.target.value)}>
                        {effortLevels.length
                          ? effortLevels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)
                          : <option value="">Not available for this model</option>}
                      </select>
                    </Label>
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
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!request.trim() || !environmentId || (autoHandoff && !effectiveHandoff?.model)}>
                Start
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
