import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
/**
 * Executed inside a ChatGPT webview. Only recognize the dedicated error panel:
 * a visible exact error string alongside a visible Retry button.
 */
export function hasChatGPTLoadFailure(): boolean {
  const message = "Could not load this ChatGPT conversation";
  const body = document.body;
  if (!body?.textContent?.includes(message)) return false;
  const visible = (element: Element): boolean => {
    for (let n: Element | null = element; n; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (
        n.hasAttribute("hidden") ||
        n.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        style.visibility === "hidden"
      )
        return false;
    }
    return element.getClientRects().length > 0;
  };
  const stop = document.querySelector(
    'button[data-testid="stop-button"], button[data-testid="composer-stop-button"]',
  );
  if (stop && visible(stop) && !stop.hasAttribute("disabled")) return false;

  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.trim() !== message) continue;
    const element = node.parentElement;
    if (
      !element ||
      !visible(element) ||
      element.closest(
        '[data-message-author-role], [data-testid^="conversation-turn-"], article, pre, code',
      )
    )
      continue;
    let container: Element | null = element;
    for (let depth = 0; container && depth < 5 && container !== body; depth++) {
      for (const button of container.querySelectorAll('button, [role="button"]')) {
        if (/^retry$/i.test(button.textContent?.trim() ?? "") && visible(button)) return true;
      }
      container = container.parentElement;
    }
  }
  return false;
}

export const CHATGPT_LOAD_FAILURE_EXPRESSION = `(${hasChatGPTLoadFailure.toString()})()`;
export type ChatGPTRecoveryProblem =
  | "load-failure"
  | "browser-unresponsive"
  | "interrupted"
  | "delivery-timeout";

export function chatGPTRecoveryProblem(activity: string): ChatGPTRecoveryProblem | null {
  if (activity === "invalid: browser-unresponsive") return "browser-unresponsive";
  // Both the explicit ChatGPT load-error panel and a persistently missing
  // composer can be repaired. The coordinator gives the ambiguous composer
  // state its own sustained-failure grace before it may reload.
  if (
    activity === "invalid: Could not load this ChatGPT conversation" ||
    activity === "invalid: the ChatGPT composer is unavailable"
  ) return "load-failure";
  if (activity === "interrupted" || activity === "delivery-timeout") return activity;
  return null;
}

// Brief interruptions often reconnect by themselves. Avoid refreshing a live
// generation immediately on the first transient orange status.
export const RECOVERY_ORANGE_GRACE_MS = 10 * 60_000;
export const RECOVERY_MISSING_COMPOSER_GRACE_MS = 60_000;
export const RECOVERY_REFRESH_TIMEOUT_MS = 8_000;
export const RECOVERY_SCAN_MS = 20_000;
export const RECOVERY_GLOBAL_MS = 20_000;
export const RECOVERY_PER_SESSION_MS = 2 * 60_000;

export interface RecoveryHistory {
  readonly lastAttemptAt: number;
  readonly bySession: Readonly<Record<string, number>>;
}
export const recoveryKey = (environmentId: string) =>
  `t3code:chatgpt-browser:recovery:${environmentId}`;
export const cooldownElapsed = (last: number, now: number, duration: number) =>
  !Number.isFinite(last) || last <= 0 || last > now || now - last >= duration;
// Most recently clicked browser sessions are inspected first. Persist a list
// rather than timestamps so rapid successive clicks have an unambiguous order.
export const recentClicksKey = (environmentId: string) =>
  `t3code:chatgpt-browser:recent-clicks:${environmentId}`;
export const lastClickedSessionKey = (environmentId: string) =>
  `t3code:chatgpt-browser:last-clicked:${environmentId}`;

export function readRecentClickedParent(
  environmentId: string,
  eligibleIds: readonly string[],
  now: number,
): string | null {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(lastClickedSessionKey(environmentId)) ?? "null",
    );
    if (!value || typeof value !== "object") return null;
    const data = value as { id?: unknown; at?: unknown };
    return typeof data.id === "string" &&
      eligibleIds.includes(data.id) &&
      typeof data.at === "number" &&
      now >= data.at &&
      now - data.at < 5 * 60_000
      ? data.id
      : null;
  } catch {
    return null;
  }
}

export function readRecentSessionClicks(environmentId: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(recentClicksKey(environmentId)) ?? "null",
    );
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((id): id is string => typeof id === "string"))]
      : [];
  } catch {
    return [];
  }
}

export function recordSessionClick(
  environmentId: string,
  sessionId: string,
  allSessionIds: readonly string[],
): void {
  if (!allSessionIds.includes(sessionId)) return;
  const retained = new Set(allSessionIds);
  const next = [
    sessionId,
    ...readRecentSessionClicks(environmentId).filter((id) => id !== sessionId && retained.has(id)),
  ];
  window.localStorage.setItem(recentClicksKey(environmentId), JSON.stringify(next));
  window.localStorage.setItem(
    lastClickedSessionKey(environmentId),
    JSON.stringify({ id: sessionId, at: Date.now() }),
  );
}

export const orderedCandidates = (
  ids: readonly string[],
  history: RecoveryHistory,
  mostRecentlyClicked: readonly string[] = [],
  deferredIds: ReadonlySet<string> = new Set(),
  redIds: ReadonlySet<string> = new Set(),
) => {
  const rank = new Map(mostRecentlyClicked.map((id, index) => [id, index]));
  return [...ids].sort((a, b) => {
    // Hidden project headings are still scanned, but only after every
    // eligible expanded-project session has had its chance.
    const aDeferred = deferredIds.has(a) ? 1 : 0;
    const bDeferred = deferredIds.has(b) ? 1 : 0;
    if (aDeferred !== bDeferred) return aDeferred - bDeferred;
    // Without a red per-session cooldown, recent clicks must not starve other red tabs.
    if (redIds.has(a) && redIds.has(b)) {
      const difference = (history.bySession[a] ?? 0) - (history.bySession[b] ?? 0);
      if (difference !== 0) return difference;
    }
    const aRank = rank.get(a);
    const bRank = rank.get(b);
    if (aRank !== undefined || bRank !== undefined) {
      return (aRank ?? Infinity) - (bRank ?? Infinity);
    }
    return (history.bySession[a] ?? 0) - (history.bySession[b] ?? 0);
  });
};

export function readRecoveryHistory(environmentId: string): RecoveryHistory {
  try {
    const parsed: unknown = getChatGPTSessionPersistedStore(environmentId).getState().recovery.history;
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid history");
    const data = parsed as { lastAttemptAt?: unknown; bySession?: unknown };
    const bySession: Record<string, number> = {};
    if (data.bySession && typeof data.bySession === "object") {
      for (const [id, value] of Object.entries(data.bySession)) {
        if (typeof value === "number" && Number.isFinite(value)) bySession[id] = value;
      }
    }
    return {
      lastAttemptAt: typeof data.lastAttemptAt === "number" ? data.lastAttemptAt : 0,
      bySession,
    };
  } catch {
    return { lastAttemptAt: 0, bySession: {} };
  }
}

export function recordRecoveryAttempt(
  environmentId: string,
  sessionId: string,
  now: number,
  ids: readonly string[],
): void {
  const previous = readRecoveryHistory(environmentId);
  const bySession = Object.fromEntries(
    ids.filter((id) => id in previous.bySession).map((id) => [id, previous.bySession[id]]),
  );
  bySession[sessionId] = now;
  const history = { lastAttemptAt: now, bySession };
  window.localStorage.setItem(recoveryKey(environmentId), JSON.stringify(history));
  const store = getChatGPTSessionPersistedStore(environmentId);
  store.setState((previous) => ({ recovery: { ...previous.recovery, history } }));
}
