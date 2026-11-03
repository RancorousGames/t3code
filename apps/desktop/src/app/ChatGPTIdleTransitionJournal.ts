// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Local durable IPC journal; wall-clock is recorded as observed evidence.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface VerifiedChatGPTIdleTransition {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly bindingRevision: string | null;
  readonly sequence: number;
  readonly eventId: string;
  readonly observedAt: number;
  readonly turnCount: number;
  readonly kind?: "completed" | "stopped" | "quiescent";
}
type Store = { version: 1; latest: Record<string, VerifiedChatGPTIdleTransition> };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const key = (environmentId: string, sessionId: string) => `${environmentId}:${sessionId}`;
function valid(event: VerifiedChatGPTIdleTransition): boolean {
  return (
    typeof event.environmentId === "string" &&
    !!event.environmentId.trim() &&
    uuid.test(event.sessionId) &&
    uuid.test(event.conversationId) &&
    (event.bindingRevision === null ||
      (typeof event.bindingRevision === "string" && event.bindingRevision.length <= 128)) &&
    (event.kind === undefined ||
      event.kind === "completed" ||
      event.kind === "stopped" ||
      event.kind === "quiescent") &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 &&
    Number.isSafeInteger(event.turnCount) &&
    event.turnCount > 0 &&
    Number.isSafeInteger(event.observedAt) &&
    event.observedAt > 0 &&
    event.observedAt < Date.now() + 60_000 &&
    event.eventId === `${event.sessionId}:${event.conversationId}:${event.sequence}`
  );
}
/** Durable, non-transcript idle notifications from the verified T3 renderer.
 * OpenRig must additionally confirm current binding/status via exact T3 read;
 * the last event alone is NOT proof the recipient is currently idle. */
export class ChatGPTIdleTransitionJournal {
  private readonly file: string;
  private latestBySession: Record<string, VerifiedChatGPTIdleTransition> = {};
  private readonly listeners = new Map<
    string,
    Set<(value: VerifiedChatGPTIdleTransition | null) => void>
  >();
  constructor(stateDir: string) {
    this.file = NodePath.join(stateDir, "chatgpt-idle-transition-bridge-v1.json");
    try {
      const parsed: unknown = JSON.parse(NodeFS.readFileSync(this.file, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        "version" in parsed &&
        parsed.version === 1 &&
        "latest" in parsed &&
        parsed.latest &&
        typeof parsed.latest === "object"
      ) {
        for (const value of Object.values(parsed.latest)) {
          const event = value as VerifiedChatGPTIdleTransition;
          if (event && valid(event))
            this.latestBySession[key(event.environmentId, event.sessionId)] = event;
        }
      }
    } catch {
      // A missing/broken journal is never evidence an idle transition happened.
    }
  }
  record(event: VerifiedChatGPTIdleTransition): boolean {
    if (!valid(event)) return false;
    const name = key(event.environmentId, event.sessionId);
    const prior = this.latestBySession[name];
    if (prior?.eventId === event.eventId) return false;
    // The renderer sequence is monotonic across conversation changes.
    if (prior && (event.sequence <= prior.sequence || event.observedAt < prior.observedAt))
      return false;
    const next = { ...this.latestBySession, [name]: event };
    // No agent or message contents are written to the journal.
    const file = this.file + ".tmp";
    try {
      NodeFS.mkdirSync(NodePath.dirname(this.file), { recursive: true });
      NodeFS.writeFileSync(file, JSON.stringify({ version: 1, latest: next } satisfies Store));
      NodeFS.renameSync(file, this.file);
    } catch {
      try {
        NodeFS.rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
      return false;
    }
    this.latestBySession = next;
    for (const listener of this.listeners.get(name) ?? []) listener(event);
    return true;
  }
  get(environmentId: string, sessionId: string): VerifiedChatGPTIdleTransition | null {
    return this.latestBySession[key(environmentId, sessionId)] ?? null;
  }
  /** Event-driven wait for one exact recipient. Timeout means unchanged, not idle. */
  wait(environmentId: string, sessionId: string, afterSequence: number, timeoutMs = 25_000) {
    const current = this.get(environmentId, sessionId);
    if (current && current.sequence > afterSequence) return Promise.resolve(current);
    const name = key(environmentId, sessionId);
    return new Promise<VerifiedChatGPTIdleTransition | null>((resolve) => {
      const bucket = this.listeners.get(name) ?? new Set();
      let timer: ReturnType<typeof setTimeout>;
      const finish = (value: VerifiedChatGPTIdleTransition | null) => {
        clearTimeout(timer);
        bucket.delete(finish);
        if (!bucket.size) this.listeners.delete(name);
        resolve(value);
      };
      bucket.add(finish);
      this.listeners.set(name, bucket);
      timer = setTimeout(() => finish(null), Math.min(30_000, Math.max(0, timeoutMs)));
      // No race between get and subscribe on this synchronous main-process lane.
    });
  }
}
