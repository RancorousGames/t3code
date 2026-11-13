/** Durable, bounded discovery requests for Bootstrap calls originating outside T3.
 * No conversation URL is guessed from the public Bootstrap UUID. */
export type ExternalBootstrapRequest = {
  id: string;
  title?: string;
  conversationUrl?: string;
  nextAttemptAt: number;
  attempts: number;
  lastError?: string;
  failed?: boolean;
};

const key = (environmentId: string) =>
  `t3code:chatgpt-external-bootstrap:v1:${environmentId}`;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const EXACT_CHAT_URL = /^https:\/\/chatgpt\.com\/c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function isExactExternalChatGPTUrl(url: string): boolean {
  return EXACT_CHAT_URL.test(url);
}

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
      (entry.conversationUrl === undefined ||
        (typeof entry.conversationUrl === "string" && isExactExternalChatGPTUrl(entry.conversationUrl))) &&
      (entry.failed === undefined || typeof entry.failed === "boolean")
    ).slice(-50);
  } catch { return []; }
}

function write(environmentId: string, requests: ExternalBootstrapRequest[]): void {
  localStorage.setItem(key(environmentId), JSON.stringify(requests.slice(-50)));
}

export function enqueueExternalBootstrapRequest(
  environmentId: string, id: string, title?: string, conversationUrl?: string,
): void {
  if (!UUID.test(id)) throw new Error("External registration requires a Bootstrap UUID.");
  if (conversationUrl && !isExactExternalChatGPTUrl(conversationUrl))
    throw new Error("External registration requires an exact https://chatgpt.com/c/<uuid> URL.");
  const requests = readExternalBootstrapRequests(environmentId);
  const existing = requests.find((entry) => entry.id === id.toLowerCase());
  if (existing?.conversationUrl && conversationUrl && existing.conversationUrl !== conversationUrl)
    throw new Error("This Bootstrap ID already has a different pending conversation.");
  if (existing && !existing.failed && (!conversationUrl || existing.conversationUrl)) return;
  const next = requests.filter((entry) => entry.id !== id.toLowerCase());
  const displayTitle = existing?.title ?? title;
  const targetUrl = conversationUrl ?? existing?.conversationUrl;
  next.push({ id: id.toLowerCase(), ...(displayTitle ? { title: displayTitle } : {}),
    ...(targetUrl ? { conversationUrl: targetUrl } : {}),
    nextAttemptAt: Date.now() + (conversationUrl ? 0 : 30_000), attempts: 0 });
  write(environmentId, next);
}

export function resolveExternalBootstrapRequest(environmentId: string, id: string): void {
  write(environmentId, readExternalBootstrapRequests(environmentId)
    .filter((entry) => entry.id !== id));
}

export function retryExternalBootstrapRequest(
  environmentId: string, id: string, reason: string,
): ExternalBootstrapRequest | undefined {
  let updated: ExternalBootstrapRequest | undefined;
  write(environmentId, readExternalBootstrapRequests(environmentId).map((entry) => {
    if (entry.id !== id) return entry;
    const attempts = entry.attempts + 1;
    updated = { ...entry, attempts, failed: attempts >= 8,
      lastError: reason.slice(0, 400), nextAttemptAt: Date.now() + 20_000 };
    return updated;
  }));
  return updated;
}
