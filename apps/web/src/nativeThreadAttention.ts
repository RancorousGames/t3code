import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import {
  activateAgentAttention,
  AGENT_ATTENTION_CHANGE_EVENT,
  type AgentAttention,
  isManualAttentionTemporarilySnoozed,
  loadAgentAttention,
  openAgentAttention,
  openAgentAttentionRequest,
  rearmManualAgentAttention,
} from "./chatGPTAgentAttention";
import { advanceChatGPTReturnMarker } from "./chatGPTBrowserSessions";
import { isCaffyIdleContinuationActive } from "./chatGPTCaffyAttentionPolicy";
import { resolveSidebarThreadStatus } from "./components/Sidebar.logic";
import { readVerifiedT3CaffyOverview } from "./hooks/useT3CaffyOverview";
import { environmentThreadShells } from "./state/threads";

/**
 * Persistent Ctrl+D attention for native T3 threads, at parity with ChatGPT sessions.
 * Threads are keyed like native Caffy (`t3:<environmentId>:<threadId>`) and share the
 * GMA request queue (toast, phone alerts, Ctrl+S). Only the marker store and the
 * working -> idle observer below are native-specific.
 */

export type NativeAttentionMarker = "armed" | "working" | "ready";
type Activity = "working" | "idle";

const STORAGE_KEY = "t3.native-thread-attention.v1";
const CHANGE_EVENT = "t3-native-thread-attention-change";

export const nativeAttentionKey = (environmentId: string, threadId: string) =>
  `t3:${environmentId}:${threadId}`;

export function parseNativeAttentionKey(
  key: string,
): { environmentId: string; threadId: string } | null {
  if (!key.startsWith("t3:")) return null;
  const rest = key.slice(3);
  const split = rest.lastIndexOf(":");
  if (split <= 0 || split === rest.length - 1) return null;
  return { environmentId: rest.slice(0, split), threadId: rest.slice(split + 1) };
}

// ── Marker store ────────────────────────────────────────────────────────────

let markersCache: Readonly<Record<string, NativeAttentionMarker>> | null = null;

export function readNativeThreadMarkers(): Readonly<Record<string, NativeAttentionMarker>> {
  if (markersCache) return markersCache;
  const markers: Record<string, NativeAttentionMarker> = {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (value && typeof value === "object") {
      for (const [key, marker] of Object.entries(value)) {
        if (marker === "armed" || marker === "working" || marker === "ready") markers[key] = marker;
      }
    }
  } catch {
    // Corrupt storage starts empty rather than breaking the sidebar.
  }
  markersCache = markers;
  return markers;
}

export function updateNativeThreadMarker(
  key: string,
  update: (marker: NativeAttentionMarker | undefined) => NativeAttentionMarker | undefined,
): void {
  const current = readNativeThreadMarkers();
  const next = update(current[key]);
  if (next === current[key]) return;
  const copy = { ...current };
  if (next) copy[key] = next;
  else delete copy[key];
  markersCache = copy;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

// ── Live thread facts, filled by the observer ───────────────────────────────

type KnownThread = {
  title: string;
  activity: Activity;
  lastActiveAt: number;
  /** Set only while the thread's own snooze is in effect. */
  snoozedUntil: number | undefined;
};
const knownThreads = new Map<string, KnownThread>();
const unvisitedWork = new Set<string>();
const deferredByCaffy = new Set<string>();

export const nativeThreadTitle = (key: string) => knownThreads.get(key)?.title;
/** Agent-supplied id -> native key: accepts a full `t3:` key or a bare thread id. */
export function resolveNativeAttentionKey(id: string): string | undefined {
  if (knownThreads.has(id)) return id;
  for (const key of knownThreads.keys())
    if (parseNativeAttentionKey(key)?.threadId === id) return key;
  return undefined;
}
export const isKnownNativeThread = (key: string) => knownThreads.has(key);
export const readNativeThreadActivity = (key: string): Activity | "unknown" =>
  knownThreads.get(key)?.activity ?? "unknown";

const isCaffyContinuing = (key: string) =>
  isCaffyIdleContinuationActive(readVerifiedT3CaffyOverview(), { id: key });

/** Native threads in the shape Ctrl+S's priorityChatGPTAttentionTarget expects:
 * every awake known thread with a marker or any queued request. */
export function nativeAttentionCandidates(
  requests: readonly AgentAttention[],
  now = Date.now(),
): Array<{
  id: string;
  returnMarker: NativeAttentionMarker | undefined;
  snoozedUntil: number | undefined;
  working: boolean;
  lastActiveAt: number;
}> {
  const markers = readNativeThreadMarkers();
  const requested = new Set(requests.map((item) => item.sessionId));
  return [...knownThreads].flatMap(([key, thread]) =>
    (markers[key] || requested.has(key)) && (thread.snoozedUntil ?? 0) <= now
      ? [
          {
            id: key,
            returnMarker: markers[key],
            snoozedUntil: thread.snoozedUntil,
            working: thread.activity === "working" || isCaffyContinuing(key),
            lastActiveAt: thread.lastActiveAt,
          },
        ]
      : [],
  );
}

/** Toast availability: the thread is known, awake, and (for Ctrl+D alerts) not
 * mid Caffy continuation. */
export function isNativeAttentionActionable(item: AgentAttention, now = Date.now()): boolean {
  const thread = knownThreads.get(item.sessionId);
  return (
    thread !== undefined &&
    (thread.snoozedUntil ?? 0) <= now &&
    !(item.source === "manual" && isCaffyContinuing(item.sessionId))
  );
}

// ── Toggle / acknowledge ────────────────────────────────────────────────────

/** Ctrl+D on a native thread. Returns the new enabled state. */
export function toggleNativeThreadAttention(key: string): boolean {
  const enabled = readNativeThreadMarkers()[key] === undefined;
  updateNativeThreadMarker(key, () =>
    enabled ? (readNativeThreadActivity(key) === "working" ? "working" : "armed") : undefined,
  );
  return enabled;
}

/** Acknowledging never disables Ctrl+D: re-arm for the NEXT completed turn. */
export function rearmNativeThreadAttention(key: string): void {
  if (!readNativeThreadMarkers()[key]) return;
  updateNativeThreadMarker(key, (marker) =>
    marker ? (readNativeThreadActivity(key) === "working" ? "working" : "armed") : undefined,
  );
  rearmManualAgentAttention([key], nativeThreadTitle(key));
}

/** Mirrors acknowledgeChatGPTSessionAttention: with a requestId only that stack
 * entry is consumed; without one (a plain visit) the whole thread is acknowledged. */
export function acknowledgeNativeThreadAttention(key: string, requestId?: string): boolean {
  if (requestId !== undefined) {
    const request = openAgentAttentionRequest(requestId, [key]);
    if (!request) return false;
    if (request.source === "manual" || readNativeThreadMarkers()[key] === "ready")
      rearmNativeThreadAttention(key);
  } else {
    openAgentAttention([key]);
    rearmNativeThreadAttention(key);
  }
  markVisited(key);
  return true;
}

function markVisited(key: string): void {
  if (readNativeThreadActivity(key) === "working") return;
  unvisitedWork.delete(key);
  deferredByCaffy.delete(key);
}

// Ctrl+S and the toast acknowledge one exact request before navigating; the
// route visit that follows must not also clear that thread's sibling requests.
let skipVisitAckFor: string | null = null;
let lastOpenKey: string | null = null;
export function skipNextNativeVisitAcknowledgement(key: string): void {
  // Already open: no route visit follows, so there is nothing to skip.
  skipVisitAckFor = key === lastOpenKey ? null : key;
}

// ── Observer ────────────────────────────────────────────────────────────────

function openThreadKey(router: AnyRouter): string | null {
  const params = (router.state.matches.at(-1)?.params ?? {}) as {
    environmentId?: string;
    threadId?: string;
  };
  return params.environmentId && params.threadId
    ? nativeAttentionKey(params.environmentId, params.threadId)
    : null;
}

/**
 * Drives native markers from thread status (working -> idle turns them yellow and
 * activates queued requests), defers while native Caffy keeps the thread going, and
 * treats visiting a thread as acknowledging it. Runs for the life of the app.
 */
export function startNativeThreadAttention(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const complete = (key: string, source?: "manual") => {
    updateNativeThreadMarker(key, (marker) =>
      marker ? advanceChatGPTReturnMarker(marker, "idle") : undefined,
    );
    activateAgentAttention([key], source);
    // The open thread's answer is already on screen.
    if (openThreadKey(router) === key) acknowledgeNativeThreadAttention(key);
  };

  const observe = (key: string, thread: Omit<KnownThread, "activity">, activity: Activity) => {
    const previous = knownThreads.get(key)?.activity;
    knownThreads.set(key, { ...thread, activity });
    if (previous === activity) return;
    if (activity === "working") {
      unvisitedWork.add(key);
      deferredByCaffy.delete(key);
      updateNativeThreadMarker(key, (marker) =>
        marker ? advanceChatGPTReturnMarker(marker, "working") : undefined,
      );
      return;
    }
    const marker = readNativeThreadMarkers()[key];
    // A turn that finished while the app was closed still counts.
    const completed =
      (previous === "working" && unvisitedWork.has(key)) ||
      (previous === undefined && marker === "working");
    if (!completed) return;
    if (marker && isCaffyContinuing(key)) {
      // Caffy is about to continue this thread; only one-off agent requests fire now.
      deferredByCaffy.add(key);
      activateAgentAttention([key], "agent");
      return;
    }
    complete(key);
  };

  const update = () => {
    const now = new Date().toISOString();
    for (const thread of registry.get(environmentThreadShells.quietThreadShellsAtom)) {
      const status = resolveSidebarThreadStatus(thread);
      observe(
        nativeAttentionKey(thread.environmentId, thread.id),
        {
          title: thread.title,
          lastActiveAt: Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt) || 0,
          snoozedUntil: effectiveSnoozed(thread, { now })
            ? Date.parse(thread.snoozedUntil ?? "")
            : undefined,
        },
        // "waiting" is parked on background work: still busy, not ready for the user.
        status === "working" || status === "waiting" ? "working" : "idle",
      );
    }
  };

  // Caffy continuations end without a thread change, so poll deferred threads.
  const flushDeferred = () => {
    for (const key of deferredByCaffy) {
      if (readNativeThreadActivity(key) !== "idle" || isCaffyContinuing(key)) continue;
      deferredByCaffy.delete(key);
      complete(key, "manual");
    }
  };

  lastOpenKey = openThreadKey(router);
  const onRoute = () => {
    const key = openThreadKey(router);
    if (key === lastOpenKey) return;
    lastOpenKey = key;
    if (!key) return;
    if (skipVisitAckFor === key) {
      skipVisitAckFor = null;
      return;
    }
    skipVisitAckFor = null;
    const hasOutstanding = loadAgentAttention().some(
      (item) => item.sessionId === key && (item.status === "pending" || item.status === "snoozed"),
    );
    if (readNativeThreadMarkers()[key] === "ready" || hasOutstanding)
      acknowledgeNativeThreadAttention(key);
    else markVisited(key);
  };

  const unsubscribes = [
    registry.subscribe(environmentThreadShells.quietThreadShellsAtom, update),
    router.subscribe("onResolved", onRoute),
  ];
  const timer = window.setInterval(flushDeferred, 10_000);
  update();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    window.clearInterval(timer);
  };
}

// ── Sidebar hook ────────────────────────────────────────────────────────────

type Snapshot = {
  markers: Readonly<Record<string, NativeAttentionMarker>>;
  requests: readonly AgentAttention[];
  now: number;
};
let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();
let stopListening: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopListening) {
    const refresh = () => {
      snapshot = null;
      for (const notify of listeners) notify();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) markersCache = null;
      refresh();
    };
    window.addEventListener(AGENT_ATTENTION_CHANGE_EVENT, refresh);
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    // Temporary snoozes expire without an event.
    const timer = window.setInterval(refresh, 15_000);
    stopListening = () => {
      window.removeEventListener(AGENT_ATTENTION_CHANGE_EVENT, refresh);
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}

const getSnapshot = (): Snapshot =>
  (snapshot ??= {
    markers: readNativeThreadMarkers(),
    requests: loadAgentAttention(),
    now: Date.now(),
  });

/** Per-row attention state: the Ctrl+D marker, whether any GMA request is
 * outstanding, and whether the manual alert is temporarily snoozed. */
export function useNativeThreadAttention(key: string): {
  marker: NativeAttentionMarker | undefined;
  outstanding: boolean;
  snoozed: boolean;
} {
  const { markers, requests, now } = useSyncExternalStore(subscribe, getSnapshot);
  return {
    marker: markers[key],
    outstanding: requests.some(
      (item) => item.sessionId === key && (item.status === "waiting" || item.status === "pending"),
    ),
    snoozed: isManualAttentionTemporarilySnoozed([key], requests, now),
  };
}
