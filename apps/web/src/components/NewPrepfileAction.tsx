import { DEFAULT_SERVER_SETTINGS, type ModelSelection } from "@t3tools/contracts";
import { isReasoningControl } from "@t3tools/client-runtime/model-traits";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { readChatGPTProviderActivity } from "../chatGPTProviderActivity";
import {
  chatGPTBrowserLastUrlKey, chatGPTBrowserLastWorkingKey, chatGPTBrowserThreadRef,
  readChatGPTBrowserSessions,
} from "../chatGPTBrowserSessions";
import { closePreviewSession } from "./preview/closePreviewSession";
import { previewEnvironment } from "../state/preview";
import { readThreadPreviewState } from "../previewStateStore";
import { useAtomCommand } from "../state/use-atom-command";
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
import { readThreadShell, useProjects, useServerConfigs, waitForThreadShell } from "../state/entities";
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
  readPrepfileGeneratorCleanupJobs,
  setPrepfileGeneratorCleanupJobs,
  updatePrepfileGeneratorCleanupJob,
  readPrepfileHandoffs,
  setPrepfileHandoffs,
  updatePrepfileHandoff,
  type PendingPrepfileHandoff,
  type PrepfileGeneratorCleanupJob,
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
import {
  installRemotePrepfileStarter,
  updateRemotePrepfileJob,
  type RemotePrepfileRequest,
} from "../prepfileRemote";

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
  const { createSession, removeSession } = useChatGPTBrowserSessions(environmentId);
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
  const deleteGeneratorThread = useOrchestrationCommand(threadEnvironment.delete, { reportFailure: false });
  const closeGeneratorPreview = useAtomCommand(previewEnvironment.close, { reportFailure: false });

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
        runtimeMode: "full-access",
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
        runtimeMode: "full-access",
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
      updateRemotePrepfileJob(job.id, (record) => ({ ...record,
        state: "completed", implementationThreadId: threadId,
      }));
      refreshPending((value) => value + 1);
      toastManager.add({
        type: "success",
        title: "Prepfile handed over",
        description: `New implementation thread ${threadId} is running.`,
      });
    } catch (cause) {
      updateRemotePrepfileJob(job.id, (record) => ({
        ...record, state: "needs_review",
        error: `${failedMessage(cause)}. Inspect the reserved implementation thread; automatic retry is disabled.`,
      }));
      toastManager.add({
        type: "error",
        title: "Prepfile handoff needs review",
        description: `${failedMessage(cause)} Auto-retry is disabled to prevent duplicate sessions.`,
      });
    }
  });

  const disposeGenerator = useEffectEvent(async (job: PrepfileGeneratorCleanupJob) => {
    // The output is already durable; close only the session identifier captured
    // at creation. Never match titles, projects, or recently visited sessions.
    if (job.generator === "native") {
      const threadRef = scopeThreadRef(job.environmentId, job.sessionId as ReturnType<typeof newThreadId>);
      const shell = readThreadShell(threadRef);
      if (shell) {
        const result = await deleteGeneratorThread({
          environmentId: job.environmentId,
          input: { threadId: threadRef.threadId },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
      if (window.location.pathname.endsWith(`/${job.sessionId}`)) void navigate({ to: "/" });
    } else {
      const exists = readChatGPTBrowserSessions(job.environmentId)
        .some((session) => session.id === job.sessionId);
      if (exists) {
        const ref = chatGPTBrowserThreadRef(job.environmentId, job.sessionId);
        for (const snapshot of Object.values(readThreadPreviewState(ref).sessions)) {
          const result = await closePreviewSession({
            closePreview: closeGeneratorPreview,
            snapshot,
            tabId: snapshot.tabId,
            threadRef: ref,
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        }
        removeSession(job.sessionId, "completed-worker");
        localStorage.removeItem(chatGPTBrowserLastUrlKey(job.environmentId, job.sessionId));
        localStorage.removeItem(chatGPTBrowserLastWorkingKey(job.environmentId, job.sessionId));
      }
      if (window.location.pathname.endsWith(`/${job.sessionId}`)) void navigate({ to: "/" });
    }
    updatePrepfileGeneratorCleanupJob(job.id, () => null);
    updateRemotePrepfileJob(job.id, (record) => ({
      ...record, cleanup: "finished",
      ...(record.state === "preparing" || record.state === "waiting_handoff"
        ? { state: "completed" as const } : {}),
    }));
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
          updateRemotePrepfileJob(job.id, (record) =>
            record.state === "preparing" ? { ...record, state: "waiting_handoff" } : record);
          // The prepfile can be written before the preparer has created the
          // TaskBoard card. Wait for the originating agent to finish all work;
          // file stability alone is not a handoff receipt.
          if (job.generatorKind) {
            if (!job.generatorSessionId) continue;
            if (job.generatorKind === "native") {
              const shell = readThreadShell(scopeThreadRef(job.environmentId,
                job.generatorSessionId as ReturnType<typeof newThreadId>));
              if (shell && (shell.latestRun?.status !== "completed" || threadRuntimeIsActive(shell.runtime))) continue;
              if (!shell && Date.now() - file.modifiedAtMs < 90_000) continue;
            } else {
              const activity = readChatGPTProviderActivity(job.environmentId, job.generatorSessionId);
              if (activity === "working" || activity === "interrupted" || activity === "delivery-timeout") continue;
              if (activity !== "idle" && Date.now() - file.modifiedAtMs < 90_000) continue;
            }
          }
          // Durable, single-shot dispatch guard: an uncertain creation is never replayed.
          if (cancelled) return;
          const targetThreadId = newThreadId();
          updatePrepfileHandoff(job.id, (entry) => ({ ...entry, state: "dispatching", targetThreadId }));
          updateRemotePrepfileJob(job.id, (record) => ({
            ...record, state: "dispatching", implementationThreadId: targetThreadId,
          }));
          refreshPending((value) => value + 1);
          await dispatchHandoff({ ...job, state: "dispatching", targetThreadId });
        }
        // Also clean up generators when automatic implementation handoff is off.
        // Avoid deleting an agent while its final writing/response turn is active.
        for (const job of readPrepfileGeneratorCleanupJobs()) {
          if (cancelled || job.environmentId !== environmentId || job.state !== "waiting") continue;
          const file = await checkFile(job.outputPath);
          const now = Date.now();
          if (!file.exists || file.size < 64 || now - file.modifiedAtMs < 5_000) {
            observedFiles.current.delete(`cleanup:${job.id}`);
            continue;
          }
          const fingerprint = `${file.size}:${file.modifiedAtMs}`;
          if (observedFiles.current.get(`cleanup:${job.id}`) !== fingerprint) {
            observedFiles.current.set(`cleanup:${job.id}`, fingerprint);
            continue;
          }
          if (job.generator === "native") {
            const shell = readThreadShell(scopeThreadRef(job.environmentId, job.sessionId as ReturnType<typeof newThreadId>));
            if (shell && (shell.latestRun?.status !== "completed" || threadRuntimeIsActive(shell.runtime))) continue;
          } else {
            const activity = readChatGPTProviderActivity(job.environmentId, job.sessionId);
            if (activity === "working" || activity === "interrupted" || activity === "delivery-timeout") continue;
            // An unloaded guest may not report idle; the stable output remains the
            // authoritative signal after a short grace period.
            if (activity !== "idle" && now - file.modifiedAtMs < 90_000) continue;
          }
          if (cancelled) return;
          updatePrepfileGeneratorCleanupJob(job.id, (entry) => ({ ...entry, state: "disposing" }));
          updateRemotePrepfileJob(job.id, (record) => ({ ...record, cleanup: "disposing" }));
          try {
            await disposeGenerator({ ...job, state: "disposing" });
          } catch (cause) {
            // Do not replay an uncertain delete or close: this ID stays reserved.
            updateRemotePrepfileJob(job.id, (record) => ({
              ...record, cleanup: "needs_review", error: failedMessage(cause),
            }));
            toastManager.add({
              type: "error", title: "Prepfile completed; session cleanup needs review",
              description: failedMessage(cause),
            });
          }
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

  type CapturedPrepfile = {
    environmentId: NonNullable<typeof environmentId>;
    request: string;
    depth: PrepfileDepth;
    generator: Generator;
    generatorSelection: ModelSelection | null;
    project: typeof project;
    autoHandoff: boolean;
    implementationSelection: ModelSelection | null;
    createTaskboardTask: boolean;
    images: File[];
  };
  const launch = useEffectEvent(async (captured: CapturedPrepfile, id: string) => {
    const generatorSelection = captured.generatorSelection;
    if (captured.generator !== "chatgpt" && !generatorSelection)
      throw new Error("The selected preparation model is unavailable.");
    if (captured.autoHandoff && !captured.implementationSelection?.model)
      throw new Error("Choose an available implementation model.");
      const outputPath = prepfileOutputPath(id, captured.request, captured.project?.title ?? null);
      updateRemotePrepfileJob(id, (record) => ({ ...record, outputPath, state: "starting" }));
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
              createTaskboardTask: captured.createTaskboardTask,
              generatorKind: captured.generator === "chatgpt" ? "chatgpt" : "native",
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
        const generatorSessionId = outcome.data.sessionId;
        updateRemotePrepfileJob(id, (record) => ({
          ...record, state: "preparing", generatorSessionId,
        }));
        updatePrepfileHandoff(id, (entry) => ({ ...entry, generatorSessionId }));
        setPrepfileGeneratorCleanupJobs([
          ...readPrepfileGeneratorCleanupJobs(),
          {
            id, environmentId: captured.environmentId, outputPath,
            createdAt: Date.now(), generator: "chatgpt",
            sessionId: outcome.data.sessionId, state: "waiting",
          },
        ]);
      } else if (targetProject && captured.generatorSelection) {
        // Preallocate and reserve a deterministic thread ID before the first write.
        // A failed/unknown create must never generate a second native preparer.
        const reservedThreadId = newThreadId();
        updateRemotePrepfileJob(id, (record) => ({
          ...record, state: "starting", generatorSessionId: reservedThreadId,
        }));
        const threadId = await startNative({
          environmentId: captured.environmentId, projectId: targetProject.id,
          title: "Prepare context file", prompt, modelSelection: captured.generatorSelection,
          threadId: reservedThreadId,
        });
        updateRemotePrepfileJob(id, (record) => ({
          ...record, state: "preparing", generatorSessionId: threadId,
        }));
        updatePrepfileHandoff(id, (entry) => ({ ...entry, generatorSessionId: threadId }));
        setPrepfileGeneratorCleanupJobs([
          ...readPrepfileGeneratorCleanupJobs(),
          {
            id, environmentId: captured.environmentId, outputPath,
            createdAt: Date.now(), generator: "native",
            sessionId: threadId, state: "waiting",
          },
        ]);
      }
      toastManager.add({
        type: "success",
        title: captured.autoHandoff ? "Prepfile started; automatic handoff armed" : "Prepfile started",
        description: "The preparation session is running independently of this dialog.",
      });
  });

  const submit = () => {
    if (submitting.current || !environmentId || !request.trim()) return;
    const captured: CapturedPrepfile = {
      environmentId, request: request.trim(), depth, generator,
      generatorSelection: generator === "chatgpt" ? null : resolveGenerator(generator),
      project, autoHandoff, implementationSelection,
      createTaskboardTask, images: [...attachedImages],
    };
    submitting.current = true;
    setOpen(false);
    requestAnimationFrame(() => { submitting.current = false; });
    setRequest("");
    setAttachedImages([]);
    setError(null);
    void launch(captured, randomUUID()).catch((cause) => {
      toastManager.add({ type: "error", title: "Prepfile start needs attention",
        description: failedMessage(cause) });
    });
  };

  const launchRemote = useEffectEvent(async (input: RemotePrepfileRequest) => {
    if (!environmentId) throw new Error("T3 desktop environment is not ready.");
    const chosenProject = input.projectId === null ? null :
      (environmentProjects.find((candidate) => candidate.id === input.projectId) ?? null);
    if (input.projectId && !chosenProject)
      throw new Error("The selected project is not available on this PC.");
    const entries = providerInstanceEntriesFor(providers, settings, chosenProject?.id ?? null)
      .filter(isProviderInstancePickerReady);
    const selectedModel = (selection: { instanceId: string; model: string } | undefined) => {
      if (!selection) return null;
      const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
      const model = entry?.models.find((candidate) => candidate.slug === selection.model);
      return model && entry ? { entry, model } : null;
    };
    const generatorOption = input.generator === "chatgpt" ? null : selectedModel(input.generatorModel);
    if (input.generator !== "chatgpt" &&
        (!generatorOption || !GENERATORS.find((item) => item.id === input.generator)
          ?.match.test(generatorOption.model.name + " " + generatorOption.model.slug)))
      throw new Error("Selected low-cost preparation model is unavailable for this project.");
    const handoffOption = input.autoHandoff ? selectedModel(input.implementationModel) : null;
    if (input.autoHandoff && !handoffOption)
      throw new Error("Selected implementation model is unavailable for this project.");
    const reasoning = handoffOption?.model.capabilities?.optionDescriptors?.find(
      (option) => option.type === "select" && isReasoningControl(option));
    const effort = input.implementationModel?.effort;
    if (effort && (!reasoning || reasoning.type !== "select" ||
      !reasoning.options.some((choice) => choice.id === effort)))
      throw new Error("Implementation effort is unsupported for the selected model.");
    const images = (input.images ?? []).map((image, index) => {
      const prefix = `data:${image.mime};base64,`;
      if (!image.dataUrl.startsWith(prefix))
        throw new Error("Invalid image payload.");
      const raw = atob(image.dataUrl.slice(prefix.length));
      if (raw.length === 0 || raw.length > 8 * 1024 * 1024)
        throw new Error("Attached image must be 1 byte–8 MiB.");
      const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
      return new File([bytes], `prepfile-image-${index + 1}`, { type: image.mime });
    });
    await launch({
      environmentId, request: input.request.trim(), depth: input.depth,
      generator: input.generator,
      generatorSelection: generatorOption
        ? { instanceId: generatorOption.entry.instanceId, model: generatorOption.model.slug }
        : null,
      project: chosenProject, autoHandoff: input.autoHandoff,
      implementationSelection: handoffOption
        ? { instanceId: handoffOption.entry.instanceId, model: handoffOption.model.slug,
          ...(reasoning && effort ? { options: [{ id: reasoning.id, value: effort }] } : {}) }
        : null,
      createTaskboardTask: input.createTaskboardTask, images,
    }, input.id);
  });
  useEffect(() => installRemotePrepfileStarter(async (input) => {
    await launchRemote(input);
  }), [environmentId]);

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
        <DialogPopup className="w-[min(720px,calc(100vw-2rem))] max-w-[720px] max-h-[calc(100dvh-2rem)] overflow-hidden">
          <form className="flex min-h-0 w-full flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); submit(); }}
            onPasteCapture={(event) => {
              const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
              if (!files.length) return;
              event.preventDefault();
              setAttachedImages((previous) => [...previous, ...files].slice(0, 8));
            }}
          >
            <DialogHeader className="shrink-0 border-b border-border/60 pb-4 pt-5">
              <DialogTitle>New prepfile</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-hidden">
              <DialogPanel className="space-y-4 !px-6 !pt-5 !pb-5">
              <div className="flex flex-col gap-4">
                <div className="min-w-0 flex flex-col gap-2">
                  <Label htmlFor="prepfile-task-request">Task / request</Label>
                  <Textarea
                    id="prepfile-task-request"
                    value={request}
                    required
                    placeholder="Describe the task, paste an issue, or specify what context to collect…"
                    onChange={(event) => setRequest(event.target.value)}
                    className="min-h-28 w-full resize-y"
                  />
                  <label htmlFor="prepfile-image-input" className="inline-flex h-8 w-fit cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground">
                    Attach images / paste screenshots
                    <input id="prepfile-image-input" type="file" accept="image/*" multiple className="sr-only"
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
                </div>
                <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="min-w-0 flex flex-col gap-1.5">
                    <Label htmlFor="prepfile-generator">Preparation agent</Label>
                    <Select
                      value={generator}
                      items={{ chatgpt: "ChatGPT session", luna: "Luna (native)", haiku: "Haiku (native)" }}
                      onValueChange={(value) => { if (value) setGenerator(value as Generator); }}
                    >
                      <SelectTrigger id="prepfile-generator" className="w-full min-w-0"><SelectValue /></SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="chatgpt">ChatGPT session</SelectItem>
                        {GENERATORS.map((item) => (
                          <SelectItem key={item.id} value={item.id} disabled={!resolveGenerator(item.id)}>
                            {item.label}{!resolveGenerator(item.id) ? " — unavailable" : ""}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                  <div className="min-w-0 flex flex-col gap-1.5">
                    <Label htmlFor="prepfile-depth">Research depth</Label>
                    <Select value={depth} items={{ light: "Light", medium: "Medium", heavy: "Heavy" }}
                      onValueChange={(value) => { if (value) setDepth(value as PrepfileDepth); }}>
                      <SelectTrigger id="prepfile-depth" className="w-full min-w-0"><SelectValue /></SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="light">Light</SelectItem>
                        <SelectItem value="medium">Medium (default)</SelectItem>
                        <SelectItem value="heavy">Heavy</SelectItem>
                      </SelectPopup>
                    </Select>
                  </div>
                </div>
                <div className="min-w-0 flex flex-col gap-1.5">
                  <Label htmlFor="prepfile-project">Project / workspace</Label>
                  <select
                    id="prepfile-project"
                    className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm"
                    value={projectChoice}
                    onChange={(event) => setProjectChoice(event.target.value)}
                  >
                    <option value="none">No project</option>
                    {environmentProjects.map((item) => (
                      <option key={item.id} value={item.id}>{item.title}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-3 border-t border-border/60 pt-4">
                  <div className="flex items-center gap-3">
                    <Checkbox id="prepfile-auto-handoff" checked={autoHandoff}
                      onCheckedChange={(value) => setAutoHandoff(value === true)} />
                    <Label htmlFor="prepfile-auto-handoff" className="cursor-pointer font-normal">
                      Start implementation automatically
                    </Label>
                  </div>
                  <div className="flex items-center gap-3">
                    <Checkbox id="prepfile-create-task" checked={createTaskboardTask} onCheckedChange={(value) => {
                      const enabled = value === true;
                      setCreateTaskboardTask(enabled);
                      localStorage.setItem("t3code:prepfile-create-taskboard:v1", String(enabled));
                    }} />
                    <Label htmlFor="prepfile-create-task" className="cursor-pointer font-normal">
                      Create TaskBoard task
                    </Label>
                  </div>
                </div>
                {autoHandoff && (
                  <div className="min-w-0 space-y-3 border-t border-border/60 pt-4">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">Implementation</h3>
                      <span className="text-xs text-muted-foreground">New T3 thread</span>
                    </div>
                    <div className="grid min-w-0 grid-cols-1 items-start gap-3 sm:grid-cols-2">
                      <div className="min-w-0 space-y-1.5">
                        <span className="block text-sm font-medium">Model</span>
                    {effectiveHandoff && environmentId ? (
                      <ProviderModelPicker
                        triggerClassName="!max-w-none w-full"
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
                      <p className="truncate text-xs text-muted-foreground" title={selectedEntry?.displayName}>
                        {selectedModel?.name ?? effectiveHandoff.model}
                      </p>
                    )}
                      </div>
                      <div className="min-w-0 space-y-1.5">
                      <Label htmlFor="prepfile-implementation-effort">Effort</Label>
                      <select id="prepfile-implementation-effort"
                        className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm"
                        value={effectiveEffort ?? ""} disabled={!effortLevels.length}
                        onChange={(event) => setEffortChoice(event.target.value)}>
                        {effortLevels.length
                          ? effortLevels.map((level) => <option key={level.id} value={level.id}>{level.label}</option>)
                          : <option value="">Unavailable</option>}
                      </select>
                      </div>
                    </div>
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
            </div>
            <DialogFooter className="shrink-0">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={!request.trim() || !environmentId || (autoHandoff && !effectiveHandoff?.model)}>
                Start preparation
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
