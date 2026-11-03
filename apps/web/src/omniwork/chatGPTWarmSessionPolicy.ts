import { create } from "zustand";

import type { ChatGPTStartupLoadPlan } from "./chatGPTStartupLoadPolicy";

/** A per-run warm working set, not a rotation queue or a persistent wake-up ledger. */
interface WarmSessions {
  readonly byEnvironment: Record<string, readonly string[]>;
  readonly loadingAt: Record<string, number>;
  /** Scheduler-computed, advisory ordering; never authority to load a guest. */
  readonly forecast: Record<string, readonly { id: string; notBefore: number; ordinal: number }[]>;
}
const EMPTY_IDS: readonly string[] = [];
export const useChatGPTWarmSessions = create<WarmSessions>(() => ({ byEnvironment: {}, loadingAt: {}, forecast: {} }));

export const useWarmChatGPTSessionIds = (environmentId: string | null) =>
  useChatGPTWarmSessions((state) =>
    environmentId ? (state.byEnvironment[environmentId] ?? EMPTY_IDS) : EMPTY_IDS,
  );

export function publishWarmChatGPTForecast(
  environmentId: string,
  proposed: readonly { id: string; notBefore: number; ordinal: number }[],
): void {
  useChatGPTWarmSessions.setState((state) => {
    const old = state.forecast[environmentId] ?? [];
    if (JSON.stringify(old) === JSON.stringify(proposed)) return state;
    return { forecast: { ...state.forecast, [environmentId]: proposed } };
  });
}
export const warmLoadingKey = (environmentId: string, id: string) => JSON.stringify([environmentId, id]);

/** Loading means a page was actively requested, not that the warm scheduler may choose it later. */
export function finishWarmChatGPTSessionLoad(environmentId: string, id: string): void {
  const key = warmLoadingKey(environmentId, id);
  useChatGPTWarmSessions.setState((state) => {
    if (!(key in state.loadingAt)) return state;
    const loadingAt = { ...state.loadingAt };
    delete loadingAt[key];
    return { loadingAt };
  });
}

export function activateWarmChatGPTSession(
  environmentId: string,
  plan: ChatGPTStartupLoadPlan,
  id: string,
): void {
  plan.activatedIds.add(id);
  useChatGPTWarmSessions.setState((state) => {
    const existing = state.byEnvironment[environmentId] ?? EMPTY_IDS;
    // A timed-out warm request can be retried without adding a second owner.
    return {
      byEnvironment: existing.includes(id) ? state.byEnvironment : {
        ...state.byEnvironment,
        [environmentId]: [...existing, id],
      },
      loadingAt: { ...state.loadingAt, [warmLoadingKey(environmentId, id)]: Date.now() },
    };
  });
}

export interface WarmCandidate {
  readonly id: string;
  readonly manager: boolean;
  readonly highlighted: boolean;
  readonly selected: boolean;
  readonly deliveryPending?: boolean;
  readonly activeBeforeFailure: boolean;
  readonly recentlyClicked: number; // 0–2 this T3 launch; -1 = not in recent three
  readonly lastActiveAt: number; // Last verified working timestamp
  readonly lastActivityAt: number; // Latest recorded activity or direct interaction
  readonly createdAt: number;
  /** Explicit message delivery may be admitted outside automatic warm capacity. */
  readonly exceedTarget?: boolean;
}

export interface WarmSelection {
  readonly candidates: readonly WarmCandidate[];
  readonly loadedIds: ReadonlySet<string>;
  readonly targetCount: number;
  readonly now: number;
}

/** Only planned residents are marked queued. Never mark every dormant session as waiting. */
export function plannedWarmChatGPTSessions(input: WarmSelection): string[] {
  if (input.targetCount <= 0) return [];
  const occupied = new Set(input.loadedIds);
  const planned: string[] = [];
  while (true) {
    const next = nextWarmChatGPTSession({ ...input, loadedIds: occupied });
    if (!next) break;
    occupied.add(next);
    planned.push(next);
  }
  return planned;
}

/** Selection is only additive. A higher priority candidate never evicts a loaded guest. */
export function nextWarmChatGPTSession(input: WarmSelection): string | null {
  if (input.targetCount <= 0) return null;
  const atCapacity = input.loadedIds.size >= input.targetCount;
  const RECENT_MS = 2 * 60 * 60_000;
  const priority = (c: WarmCandidate): number => {
    if (c.selected) return 0;
    if (c.deliveryPending) return 1;
    if (c.activeBeforeFailure) return 2;
    if (c.recentlyClicked >= 0) return 3;
    if (c.highlighted) return 4;
    if (c.lastActiveAt > 0 && c.lastActiveAt >= input.now - RECENT_MS) return 5;
    if (c.manager) return 6;
    if (c.lastActivityAt > 0) return 7;
    return 8;
  };
  const choice = input.candidates
    .filter((candidate) =>
      !input.loadedIds.has(candidate.id) && (!atCapacity || candidate.exceedTarget === true),
    )
    .sort((a, b) =>
      priority(a) - priority(b) ||
      ((a.recentlyClicked >= 0 ? a.recentlyClicked : 1e9) -
        (b.recentlyClicked >= 0 ? b.recentlyClicked : 1e9)) ||
      b.lastActivityAt - a.lastActivityAt ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
    )[0];
  return choice?.id ?? null;
}
