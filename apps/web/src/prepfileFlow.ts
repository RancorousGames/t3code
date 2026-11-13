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
}

const STORAGE_KEY = "t3code:prepfile-handoffs:v1";
const SKILL_PATH = "C:\\Users\\crovea\\.agents\\skills\\extra-skill-finder\\on-request\\prepfile\\SKILL.md";

export function prepfileOutputPath(id: string, request: string, projectTitle: string | null): string {
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
  imagePaths?: readonly string[];
}): string {
  return [
    "Use the PREPFILE skill to prepare research/context for the exact request below. Read and follow the full skill file at:",
    SKILL_PATH,
    "",
    `Depth: ${input.depth}. Save the ONLY final prepfile as UTF-8 Markdown at this exact absolute path:`,
    input.outputPath,
    "",
    "Create the destination folder and use the prepfile skill's bundled build_context.py writer with --output set to the exact path above. Do not save a different filename: T3 monitors this path and triggers handoff only when it is stable. Verify the completed output according to the skill. Preserve the verbatim user request at the top, with source-labelled excerpts and the skill's deletion instruction. Do NOT implement the requested work or modify project files.",
    input.hasAutomaticHandoff
      ? "The T3 app will detect this exact file and create the selected implementation thread automatically; do NOT hand over or start implementation yourself."
      : "Do not hand over or start implementation. Return the absolute file path when complete.",
    "",
    ...(input.createTaskboardTask
      ? ["", "TASKBOARD: After gathering context, create ONE TaskBoard task for this request if none exists already. Search the appropriate board and avoid duplicates. Include the generated prepfile path in task AI Notes. Do not implement it. If the correct board cannot be identified, ask for it rather than inventing a location."]
      : ["", "Do not create a TaskBoard task."]),
    ...(input.imagePaths?.length
      ? ["", "ATTACHED IMAGES (absolute local paths; inspect all and reference their contents in your prepfile):", ...input.imagePaths]
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
    "",
    "ORIGINAL REQUEST:",
    job.request,
  ].join("\n");
}

export function readPrepfileHandoffs(): PendingPrepfileHandoff[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((job): job is PendingPrepfileHandoff =>
      typeof job === "object" && job !== null &&
      typeof job.id === "string" && typeof job.outputPath === "string" &&
      typeof job.request === "string" && typeof job.createdAt === "number" &&
      (job.state === "waiting" || job.state === "dispatching") &&
      typeof job.modelSelection?.instanceId === "string" &&
      typeof job.modelSelection?.model === "string" &&
      typeof job.environmentId === "string" && typeof job.projectId === "string"
    ).slice(-20);
  } catch {
    return [];
  }
}

export function setPrepfileHandoffs(jobs: readonly PendingPrepfileHandoff[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs.slice(-20)));
}

export function updatePrepfileHandoff(
  id: string,
  update: ((job: PendingPrepfileHandoff) => PendingPrepfileHandoff | null),
): void {
  const next = readPrepfileHandoffs().flatMap((job) => {
    if (job.id !== id) return [job];
    const updated = update(job);
    return updated ? [updated] : [];
  });
  setPrepfileHandoffs(next);
}
