import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useSyncExternalStore } from "react";

import {
  chatGPTBrowserLastWorkingKey,
  readChatGPTBrowserSessions,
} from "../../chatGPTBrowserSessions";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

export const ACTIVE_HISTORY_WINDOW_MS = 5 * 60 * 60_000;
export const ACTIVE_SAMPLE_INTERVAL_MS = 60_000;
// Samples further apart than this belong to separate observation runs; the
// span between them is shown as unknown rather than interpolated.
export const ACTIVE_SAMPLE_GAP_MS = 2.5 * ACTIVE_SAMPLE_INTERVAL_MS;
// The sidebar activity monitor persists a heartbeat at most ~40s apart while a
// session is working (30s heartbeat + 6s background poll + 4s probe timeout).
const WORKING_HEARTBEAT_FRESH_MS = 45_000;
// Let the activity monitors complete their first probe after a launch.
const FIRST_SAMPLE_DELAY_MS = 20_000;
const MAX_SAMPLES = Math.ceil(ACTIVE_HISTORY_WINDOW_MS / ACTIVE_SAMPLE_INTERVAL_MS) + 30;
// Heartbeats persisted by an earlier run describe the past, not this launch.
const launchedAt = Date.now();

const ActiveSample = Schema.Struct({
  at: Schema.Number.check(Schema.isFinite()),
  working: Schema.Number.check(Schema.isFinite()),
  tracked: Schema.Number.check(Schema.isFinite()),
});
export type ActiveSample = typeof ActiveSample.Type;
const ActiveSamples = Schema.Array(ActiveSample);

const storageKey = (environmentId: EnvironmentId) =>
  `t3code:chatgpt-active-history:v1:${environmentId}`;

/** Count monitored sessions whose working heartbeat was observed during this launch. */
export function countWorkingChatGPTSessions(environmentId: EnvironmentId, now: number) {
  const since = Math.max(now - WORKING_HEARTBEAT_FRESH_MS, launchedAt);
  // Hidden and archived sessions have no activity monitor, so they cannot report work.
  const tracked = readChatGPTBrowserSessions(environmentId).filter(
    (session) => !session.hidden && (!session.archive || session.archive.restoredAt),
  );
  let working = 0;
  for (const session of tracked) {
    try {
      const at = Number(
        localStorage.getItem(chatGPTBrowserLastWorkingKey(environmentId, session.id)),
      );
      if (Number.isFinite(at) && at >= since && at <= now + 5_000) working++;
    } catch {
      /* An unreadable heartbeat is not evidence of work. */
    }
  }
  return { working, tracked: tracked.length };
}

export function appendActiveSample(
  samples: readonly ActiveSample[],
  sample: ActiveSample,
): readonly ActiveSample[] {
  const cutoff = sample.at - ACTIVE_HISTORY_WINDOW_MS;
  return [...samples.filter((entry) => entry.at >= cutoff && entry.at < sample.at), sample].slice(
    -MAX_SAMPLES,
  );
}

/** Split samples into contiguous observation runs; anything between runs is unobserved. */
export function activeSampleRuns(samples: readonly ActiveSample[]): ActiveSample[][] {
  const runs: ActiveSample[][] = [];
  for (const sample of samples) {
    const run = runs[runs.length - 1];
    const previous = run?.[run.length - 1];
    if (run && previous && sample.at - previous.at <= ACTIVE_SAMPLE_GAP_MS) run.push(sample);
    else runs.push([sample]);
  }
  return runs;
}

// One sampler is shared by every mounted widget so remounts on route changes
// neither duplicate samples nor postpone the next one.
let current: { environmentId: EnvironmentId; samples: readonly ActiveSample[] } | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function load(environmentId: EnvironmentId) {
  if (current?.environmentId === environmentId) return current;
  let samples: readonly ActiveSample[] = [];
  try {
    samples = getLocalStorageItem(storageKey(environmentId), ActiveSamples) ?? [];
  } catch {
    /* Start a fresh history when the stored one is unreadable. */
  }
  const cutoff = Date.now() - ACTIVE_HISTORY_WINDOW_MS;
  current = {
    environmentId,
    samples: samples.filter((sample) => sample.at >= cutoff).slice(-MAX_SAMPLES),
  };
  return current;
}

function takeSample() {
  if (!current) return;
  const now = Date.now();
  const { working, tracked } = countWorkingChatGPTSessions(current.environmentId, now);
  current = {
    environmentId: current.environmentId,
    samples: appendActiveSample(current.samples, { at: now, working, tracked }),
  };
  try {
    setLocalStorageItem(storageKey(current.environmentId), current.samples, ActiveSamples);
  } catch {
    /* The chart still works in memory when storage is unavailable. */
  }
  for (const listener of listeners) listener();
}

function schedule() {
  if (timer !== undefined) clearTimeout(timer);
  const last = current?.samples[current.samples.length - 1]?.at ?? 0;
  const due = Math.max(launchedAt + FIRST_SAMPLE_DELAY_MS, last + ACTIVE_SAMPLE_INTERVAL_MS);
  timer = setTimeout(
    () => {
      timer = undefined;
      takeSample();
      if (listeners.size > 0) schedule();
    },
    Math.max(0, due - Date.now()),
  );
}

const EMPTY: readonly ActiveSample[] = [];

/** Rolling five-hour history of working ChatGPT browser sessions, sampled once a minute. */
export function useChatGPTActiveHistory(environmentId: EnvironmentId | null, enabled: boolean) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled || environmentId === null) return () => {};
      load(environmentId);
      listeners.add(listener);
      if (timer === undefined) schedule();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    },
    [enabled, environmentId],
  );
  const getSnapshot = useCallback(
    () => (enabled && environmentId !== null ? load(environmentId).samples : EMPTY),
    [enabled, environmentId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}
