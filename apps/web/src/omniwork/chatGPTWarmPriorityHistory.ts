/** Persist only observed working status, so a T3 restart can restore previously green tabs. */
const activityKey = (environmentId: string, sessionId: string) =>
  `t3code:chatgpt-browser:warm-activity:${environmentId}:${sessionId}`;
const clickKey = (environmentId: string) =>
  `t3code:chatgpt-browser:warm-clicks-this-launch:${environmentId}`;

interface WarmActivity {
  readonly wasWorking: boolean;
  readonly activeBeforeError: boolean;
}
function readActivity(environmentId: string, sessionId: string): WarmActivity {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(activityKey(environmentId, sessionId)) ?? "null");
    if (value && typeof value === "object") {
      const entry = value as Partial<WarmActivity>;
      return { wasWorking: entry.wasWorking === true, activeBeforeError: entry.activeBeforeError === true };
    }
  } catch { /* A damaged record is not evidence of activity. */ }
  return { wasWorking: false, activeBeforeError: false };
}

/** Unknown/loading probes preserve previous evidence. Healthy idle clears it. */
export function recordWarmActivityObservation(
  environmentId: string,
  sessionId: string,
  state: "working" | "idle" | "invalid" | "interrupted" | "delivery-timeout" | "unknown",
): void {
  if (state === "unknown") return;
  const previous = readActivity(environmentId, sessionId);
  const next: WarmActivity = state === "working"
    ? { wasWorking: true, activeBeforeError: false }
    : state === "idle"
      ? { wasWorking: false, activeBeforeError: false }
      : { wasWorking: false, activeBeforeError: previous.wasWorking || previous.activeBeforeError };
  if (next.wasWorking === previous.wasWorking && next.activeBeforeError === previous.activeBeforeError) return;
  try { localStorage.setItem(activityKey(environmentId, sessionId), JSON.stringify(next)); }
  catch { /* Best-effort priority evidence; never interrupt activity monitoring. */ }
}

export function wasWarmSessionActiveBeforeFailure(environmentId: string, sessionId: string): boolean {
  const state = readActivity(environmentId, sessionId);
  return state.wasWorking || state.activeBeforeError;
}

/** sessionStorage survives an in-app reload, but not a new T3 window launch. */
export function recordWarmSessionClick(
  environmentId: string,
  sessionId: string,
  allSessionIds: readonly string[],
): void {
  if (!allSessionIds.includes(sessionId)) return;
  try {
    const validIds = new Set(allSessionIds);
    const existing = readWarmSessionClicks(environmentId);
    sessionStorage.setItem(clickKey(environmentId), JSON.stringify([
      sessionId, ...existing.filter((id) => id !== sessionId && validIds.has(id)),
    ].slice(0, 3)));
  } catch { /* Optional ranking signal. */ }
}
export function readWarmSessionClicks(environmentId: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(clickKey(environmentId)) ?? "null");
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((id): id is string => typeof id === "string"))].slice(0, 3)
      : [];
  } catch { return []; }
}

/** Selected tab takes the first recent-click slot even if restored automatically. */
export function warmRecentClickRanks(
  environmentId: string,
  selectedId: string | null,
): ReadonlyMap<string, number> {
  const ids = [...new Set([
    ...(selectedId ? [selectedId] : []),
    ...readWarmSessionClicks(environmentId),
  ])].slice(0, 3);
  return new Map(ids.map((id, index) => [id, index]));
}
