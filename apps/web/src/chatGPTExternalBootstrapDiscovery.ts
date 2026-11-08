/** Durable, bounded discovery requests for Bootstrap calls originating outside T3.
 * No conversation URL is guessed from the public Bootstrap UUID. */
export type ExternalBootstrapRequest = {
  id: string;
  title?: string;
  nextAttemptAt: number;
  attempts: number;
  lastError?: string;
  failed?: boolean;
};

const key = (environmentId: string) =>
  `t3code:chatgpt-external-bootstrap:v1:${environmentId}`;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function readExternalBootstrapRequests(environmentId: string): ExternalBootstrapRequest[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(environmentId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ExternalBootstrapRequest =>
      !!entry && typeof entry === "object" &&
      typeof entry.id === "string" && UUID.test(entry.id) &&
      typeof entry.nextAttemptAt === "number" && Number.isFinite(entry.nextAttemptAt) &&
      typeof entry.attempts === "number" && entry.attempts >= 0 &&
      (entry.title === undefined || typeof entry.title === "string") &&
      (entry.failed === undefined || typeof entry.failed === "boolean")
    ).slice(-50);
  } catch { return []; }
}

function write(environmentId: string, requests: ExternalBootstrapRequest[]): void {
  localStorage.setItem(key(environmentId), JSON.stringify(requests.slice(-50)));
}

export function enqueueExternalBootstrapRequest(
  environmentId: string, id: string, title?: string,
): void {
  if (!UUID.test(id)) return;
  const requests = readExternalBootstrapRequests(environmentId);
  const existing = requests.find((entry) => entry.id === id);
  if (existing && !existing.failed) return;
  const next = requests.filter((entry) => entry.id !== id);
  next.push({ id: id.toLowerCase(), ...(title ? { title } : {}),
    nextAttemptAt: Date.now() + 30_000, attempts: 0 });
  write(environmentId, next);
}

export function resolveExternalBootstrapRequest(environmentId: string, id: string): void {
  write(environmentId, readExternalBootstrapRequests(environmentId)
    .filter((entry) => entry.id !== id));
}

export function retryExternalBootstrapRequest(
  environmentId: string, id: string, reason: string,
): void {
  write(environmentId, readExternalBootstrapRequests(environmentId).map((entry) => {
    if (entry.id !== id) return entry;
    const attempts = entry.attempts + 1;
    return { ...entry, attempts, failed: attempts >= 8,
      lastError: reason.slice(0, 200), nextAttemptAt: Date.now() + 20_000 };
  }));
}
