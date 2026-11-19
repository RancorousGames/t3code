import type { EnvironmentId, ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";

export type PrepfileDepth = "light" | "medium" | "heavy";

export interface PendingPrepfileHandoff {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly outputPath: string;
  readonly request: string;
  readonly createdAt: number;
  readonly state: "waiting" | "dispatching";
  readonly targetThreadId?: ThreadId;
  /** Present on new jobs; old persisted handoffs remain readable. */
  readonly createTaskboardTask?: boolean;
  /** Existing task from TaskBoard's create dialog, not a new task to create. */
  readonly taskRef?: { board: string; id: string };
  readonly generatorKind?: "chatgpt" | "native";
  readonly generatorSessionId?: string;
}

export interface PrepfileGeneratorCleanupJob {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly outputPath: string;
  readonly createdAt: number;
  readonly generator: "chatgpt" | "native";
  readonly sessionId: string;
  readonly state: "waiting" | "disposing";
}

const CLEANUP_STORAGE_KEY = "t3code:prepfile-generators:v1";

export function readPrepfileGeneratorCleanupJobs(): PrepfileGeneratorCleanupJob[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CLEANUP_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (job): job is PrepfileGeneratorCleanupJob =>
          typeof job === "object" &&
          job !== null &&
          typeof job.id === "string" &&
          typeof job.environmentId === "string" &&
          typeof job.outputPath === "string" &&
          typeof job.createdAt === "number" &&
          (job.generator === "chatgpt" || job.generator === "native") &&
          typeof job.sessionId === "string" &&
          (job.state === "waiting" || job.state === "disposing"),
      )
      .slice(-30);
  } catch {
    return [];
  }
}

export function setPrepfileGeneratorCleanupJobs(
  jobs: readonly PrepfileGeneratorCleanupJob[],
): void {
  localStorage.setItem(CLEANUP_STORAGE_KEY, JSON.stringify(jobs.slice(-30)));
}

export function updatePrepfileGeneratorCleanupJob(
  id: string,
  update: (job: PrepfileGeneratorCleanupJob) => PrepfileGeneratorCleanupJob | null,
): void {
  setPrepfileGeneratorCleanupJobs(
    readPrepfileGeneratorCleanupJobs().flatMap((job) => {
      if (job.id !== id) return [job];
      const next = update(job);
      return next ? [next] : [];
    }),
  );
}

const STORAGE_KEY = "t3code:prepfile-handoffs:v1";
const SKILL_PATH =
  "C:\\Users\\crovea\\.agents\\skills\\extra-skill-finder\\on-request\\prepfile\\SKILL.md";

export function prepfileOutputPath(
  id: string,
  request: string,
  projectTitle: string | null,
): string {
  const taskId = request.match(/\b[A-Z][A-Z0-9]{1,11}-\d{4,}\b/)?.[0];
  const safeProject = projectTitle?.replace(/[<>:"/\\|?*]/g, "").trim();
  if (taskId && safeProject) {
    return `E:\\_AgentScratch\\Tasks\\${safeProject}\\${taskId}\\Deliverables\\prepfile-${id}.md`;
  }
  return `E:\\_AgentScratch\\Unassigned\\Prepfile\\Deliverables\\prepfile-${id}.md`;
}

export function buildPrepfileInstruction(input: {
  request: string;
  outputPath: string;
  depth: PrepfileDepth;
  hasAutomaticHandoff: boolean;
  createTaskboardTask?: boolean;
  taskRef?: { board: string; id: string };
  imagePaths?: readonly string[];
}): string {
  return [
    "Use the PREPFILE skill to prepare research/context for the exact request below. Read and follow the full skill file at:",
    SKILL_PATH,
    "",
    `Depth: ${input.depth}. Save the ONLY final prepfile as UTF-8 Markdown at this exact absolute path:`,
    input.outputPath,
    "",
    ...(input.taskRef
      ? [
          `EXISTING TASKBOARD TASK: ${input.taskRef.board} / ${input.taskRef.id}. Read the canonical task, its acceptance criteria and attached images. Its human-authored title, description, acceptance criteria and corrections are the actual task request: copy that task text verbatim to the top of the prepfile (not merely the task ID / locator below). The human has already created this task; do NOT create another, claim it or implement it during preparation.`,
          "",
        ]
      : []),
    ...(input.createTaskboardTask
      ? [
          "TASKBOARD: After gathering context, find or create ONE matching TaskBoard task on the correct board before writing the final prepfile. Avoid duplicates, record the prepfile path in its AI Notes, and include the exact task ID and owning board root in the final prepfile. Do not implement the task yourself. If its board cannot be identified, ask rather than inventing a location.",
          "",
        ]
      : ["Do not create a TaskBoard task.", ""]),
    "Create the destination folder and use the prepfile skill's bundled build_context.py writer with --output set to the exact path above. Write the final file only after finishing other preparation work, including any requested TaskBoard creation: T3 uses it as the handoff signal. Do not save a different filename. Verify the completed output according to the skill. Preserve the verbatim request at the top, source-labelled excerpts and the deletion instruction. Do NOT implement the requested work or modify project files.",
    input.hasAutomaticHandoff
      ? "The T3 app will detect this exact file and create the selected implementation thread automatically; do NOT hand over or start implementation yourself."
      : "Do not hand over or start implementation. Return the absolute file path when complete.",
    "",
    ...(input.imagePaths?.length
      ? [
          "",
          "ATTACHED IMAGES (absolute local paths; inspect all and reference their contents in your prepfile):",
          ...input.imagePaths,
        ]
      : []),
    "",
    "VERBATIM REQUEST:",
    input.request,
  ].join("\n");
}

export function buildPrepfileHandoffInstruction(job: PendingPrepfileHandoff): string {
  return [
    "Implement the original request using this freshly generated, disposable PREPFILE context:",
    job.outputPath,
    ...(job.taskRef
      ? [
          "",
          `EXISTING TASKBOARD TASK: ${job.taskRef.board} / ${job.taskRef.id}.`,
          "Use this exact existing task; do not create a duplicate. It was held in Draft with a prepare flag while its prepfile was generated. Read its taskboard:prepfile-target marker. Release it to that target column and claim it for THIS implementation thread before implementing; if the TaskBoard CLI cannot claim Draft, transition and immediately claim, reconciling any existing claim instead of duplicating work. Keep its status updated. Remove the prepare attention flag when handing off; do not start another implementation agent.",
          ...(job.targetThreadId
            ? [`This implementation thread's claimant is t3:${job.targetThreadId}.`]
            : []),
        ]
      : []),
    ...(job.createTaskboardTask
      ? [
          "",
          "The preparer also created or located a TaskBoard task. Read its exact ID and board root from the prepfile, then claim that task before implementing. Keep its progress/status updated; do not create another task. If it is already claimed, reconcile the existing owner rather than starting duplicate work.",
          ...(job.targetThreadId
            ? [`This implementation thread's TaskBoard claimant is t3:${job.targetThreadId}.`]
            : []),
        ]
      : []),
    "",
    "ORIGINAL REQUEST:",
    job.request,
  ].join("\n");
}

export function readPrepfileHandoffs(): PendingPrepfileHandoff[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (job): job is PendingPrepfileHandoff =>
          typeof job === "object" &&
          job !== null &&
          typeof job.id === "string" &&
          typeof job.outputPath === "string" &&
          typeof job.request === "string" &&
          typeof job.createdAt === "number" &&
          (job.state === "waiting" || job.state === "dispatching") &&
          typeof job.modelSelection?.instanceId === "string" &&
          typeof job.modelSelection?.model === "string" &&
          typeof job.environmentId === "string" &&
          typeof job.projectId === "string",
      )
      .slice(-20);
  } catch {
    return [];
  }
}

export function setPrepfileHandoffs(jobs: readonly PendingPrepfileHandoff[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs.slice(-20)));
}

export function updatePrepfileHandoff(
  id: string,
  update: (job: PendingPrepfileHandoff) => PendingPrepfileHandoff | null,
): void {
  const next = readPrepfileHandoffs().flatMap((job) => {
    if (job.id !== id) return [job];
    const updated = update(job);
    return updated ? [updated] : [];
  });
  setPrepfileHandoffs(next);
}
