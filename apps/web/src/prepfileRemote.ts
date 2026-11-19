import type { PrepfileDepth } from "./prepfileFlow";

/** The PC's T3 renderer owns these receipts and executes the same preparation workflow as desktop UI. */
export interface RemotePrepfileRequest {
  id: string;
  request: string;
  depth: PrepfileDepth;
  generator: "chatgpt" | "luna" | "haiku";
  projectId: string | null;
  /** Resolve an existing T3 project by its exact TaskBoard project name when projectId is absent. */
  projectName?: string;
  autoHandoff: boolean;
  createTaskboardTask: boolean;
  /** Optional existing TaskBoard scope; never implicitly creates another task. */
  taskRef?: { board: string; id: string };
  generatorModel?: { instanceId: string; model: string };
  implementationModel?: { instanceId: string; model: string; effort?: string };
  images?: Array<{ mime: string; dataUrl: string }>;
  imageRefs?: Array<{ index: number; mime: string }>;
}

export interface RemotePrepfileJob {
  id: string;
  request: string;
  outputPath: string | null;
  taskRef?: { board: string; id: string };
  state:
    | "reserved"
    | "starting"
    | "preparing"
    | "waiting_handoff"
    | "dispatching"
    | "completed"
    | "needs_review";
  createdAt: number;
  generatorSessionId?: string;
  implementationThreadId?: string;
  error?: string;
  cleanup?: "waiting" | "disposing" | "finished" | "needs_review";
}

const KEY = "t3code:remote-prepfile-jobs:v1";
const MAX_JOBS = 40;
const MAX_IMAGE_CHUNKS = 90; // 90 x 12 KB = 1.08 MB; safe for browser storage
const UPLOAD_PREFIX = "t3code:remote-prepfile-image:v1:";

type StagedImage = {
  mime: string;
  parts: number;
  chunks: Record<number, string>;
  createdAt: number;
};

const imageKey = (id: string, index: number) => `${UPLOAD_PREFIX}${id}:${index}`;
function readImage(id: string, index: number): StagedImage | null {
  try {
    const raw = localStorage.getItem(imageKey(id, index));
    return raw ? (JSON.parse(raw) as StagedImage) : null;
  } catch {
    return null;
  }
}

function cleanupStaleImages() {
  const now = Date.now();
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key?.startsWith(UPLOAD_PREFIX)) continue;
    try {
      const staged = JSON.parse(localStorage.getItem(key) ?? "") as StagedImage;
      if (!Number.isFinite(staged.createdAt) || now - staged.createdAt > 48 * 3_600_000)
        localStorage.removeItem(key);
    } catch {
      localStorage.removeItem(key);
    }
  }
}

/** Idempotent, bounded parts fit under SignalR's standard 32 KiB message limit. */
export function stageRemotePrepfileImageChunk(input: {
  id: string;
  index: number;
  part: number;
  total: number;
  mime: string;
  chunk: string;
}) {
  if (
    !UUID.test(input.id) ||
    !Number.isInteger(input.index) ||
    input.index < 0 ||
    input.index >= 8 ||
    !Number.isInteger(input.part) ||
    input.part < 0 ||
    !Number.isInteger(input.total) ||
    input.total < 1 ||
    input.total > MAX_IMAGE_CHUNKS ||
    input.part >= input.total ||
    input.mime !== "image/jpeg" ||
    typeof input.chunk !== "string" ||
    !/^[A-Za-z0-9+/=]+$/.test(input.chunk) ||
    input.chunk.length > 12_000 ||
    input.chunk.length < 1
  )
    throw new Error("Invalid prepfile image chunk (JPEG, <=12 KB, <=90 chunks).");
  if (readRemotePrepfileJobs().some((job) => job.id === input.id))
    throw new Error("Prepfile job already submitted; images cannot be modified after reservation.");
  cleanupStaleImages();
  const existing = readImage(input.id, input.index);
  if (existing && (existing.mime !== input.mime || existing.parts !== input.total))
    throw new Error("Image upload header changed; start a distinct request.");
  const previous = existing?.chunks[input.part];
  if (previous !== undefined && previous !== input.chunk)
    throw new Error("Image chunk differs from the saved chunk for this request ID.");
  if (previous === undefined) {
    const staged: StagedImage = existing ?? {
      mime: input.mime,
      parts: input.total,
      chunks: {},
      createdAt: Date.now(),
    };
    staged.chunks[input.part] = input.chunk;
    localStorage.setItem(imageKey(input.id, input.index), JSON.stringify(staged));
  }
  return {
    index: input.index,
    received: Object.keys(readImage(input.id, input.index)?.chunks ?? {}).length,
    total: input.total,
  };
}

function materializeImages(request: RemotePrepfileRequest) {
  if (request.images?.length && request.imageRefs?.length)
    throw new Error("Choose staged images or inline images, not both.");
  if (!request.imageRefs?.length) return request.images ?? [];
  return request.imageRefs.map(({ index, mime }) => {
    if (!Number.isInteger(index) || index < 0 || index >= 8 || mime !== "image/jpeg")
      throw new Error("Invalid image upload reference.");
    const image = readImage(request.id, index);
    if (!image || image.mime !== mime || Object.keys(image.chunks).length !== image.parts)
      throw new Error(
        `Image ${index + 1} is incomplete. Resume uploading with the same request ID.`,
      );
    const raw = Array.from({ length: image.parts }, (_, part) => image.chunks[part] ?? "").join("");
    if (!raw || raw.length > 1_200_000) throw new Error("Staged image is empty or too large.");
    return { mime, dataUrl: `data:${mime};base64,${raw}` };
  });
}

function clearStagedImages(request: RemotePrepfileRequest) {
  request.imageRefs?.forEach(({ index }) => localStorage.removeItem(imageKey(request.id, index)));
}
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
let starter: ((request: RemotePrepfileRequest) => Promise<void>) | null = null;

export function readRemotePrepfileJobs(): RemotePrepfileJob[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (job): job is RemotePrepfileJob =>
          !!job &&
          UUID.test(job.id) &&
          typeof job.request === "string" &&
          typeof job.createdAt === "number" &&
          typeof job.state === "string",
      )
      .slice(-MAX_JOBS);
  } catch {
    return [];
  }
}

export function updateRemotePrepfileJob(
  id: string,
  update: (row: RemotePrepfileJob) => RemotePrepfileJob,
): void {
  const records = readRemotePrepfileJobs();
  if (!records.some((row) => row.id === id)) return;
  localStorage.setItem(
    KEY,
    JSON.stringify(records.map((row) => (row.id === id ? update(row) : row))),
  );
}

export function installRemotePrepfileStarter(
  handler: (request: RemotePrepfileRequest) => Promise<void>,
): () => void {
  starter = handler;
  return () => {
    if (starter === handler) starter = null;
  };
}

/**
 * Reserve idempotently BEFORE any non-repeatable browser or agent operation.
 * On uncertain delivery a phone reads the journal; it never submits the same request twice.
 */
export function startRemotePrepfile(request: RemotePrepfileRequest): RemotePrepfileJob {
  if (!UUID.test(request.id)) throw new Error("Stable prepfile UUID required.");
  if (!request.request?.trim() || request.request.length > 30_000)
    throw new Error("Prepfile request must be 1–30000 characters.");
  if (
    !["light", "medium", "heavy"].includes(request.depth) ||
    !["chatgpt", "luna", "haiku"].includes(request.generator)
  )
    throw new Error("Unsupported prepfile depth or generator.");
  if (
    request.taskRef &&
    (!request.taskRef.board?.trim() ||
      request.taskRef.board.length > 500 ||
      !/^[A-Za-z][A-Za-z0-9]*-[0-9]{4,}$/.test(request.taskRef.id))
  )
    throw new Error("Linked TaskBoard reference invalid.");
  if (
    request.images &&
    (request.images.length > 8 ||
      request.images.some(
        (image) =>
          !/^image\/(png|jpeg|webp|gif)$/.test(image.mime) || image.dataUrl.length > 11_200_000,
      ))
  )
    throw new Error("Up to 8 PNG/JPEG/WEBP/GIF images (8 MiB each) are supported.");
  const existing = readRemotePrepfileJobs().find((job) => job.id === request.id);
  if (existing) {
    if (
      existing.request !== request.request.trim() ||
      JSON.stringify(existing.taskRef ?? null) !== JSON.stringify(request.taskRef ?? null)
    )
      throw new Error("Prepfile ID is already reserved for a different request or task.");
    return existing;
  }
  if (!starter) throw new Error("PC prepfile controller is unavailable; open T3 desktop.");
  const preparedImages = materializeImages(request);
  const prepared: RemotePrepfileRequest = { ...request, images: preparedImages };
  const reserved: RemotePrepfileJob = {
    id: request.id,
    request: request.request.trim(),
    outputPath: null,
    ...(request.taskRef ? { taskRef: request.taskRef } : {}),
    createdAt: Date.now(),
    state: "reserved",
  };
  localStorage.setItem(
    KEY,
    JSON.stringify([...readRemotePrepfileJobs(), reserved].slice(-MAX_JOBS)),
  );
  const run = starter;
  // Async work must not outlive its durable receipt; no implicit retry on restart.
  void run(prepared)
    .catch((cause: unknown) => {
      updateRemotePrepfileJob(request.id, (job) => ({
        ...job,
        state: "needs_review",
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    })
    .finally(() => clearStagedImages(request));
  return reserved;
}
