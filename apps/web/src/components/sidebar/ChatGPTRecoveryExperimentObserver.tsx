import { useEffect } from "react";
import { randomUUID } from "../../lib/utils";
import {
  claimRecoveryExperimentSampler,
  releaseRecoveryExperimentSampler,
} from "../../chatGPTRecoveryExperimentLease";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { isElectron } from "../../env";
import { getChatGPTSessionPersistedStore } from "../../chatGPTSessionPersistedStore";
import { readChatGPTBrowserSessions } from "../../chatGPTBrowserSessions";
import { readChatGPTRecoveryMetrics } from "../../chatGPTRecoveryMetrics";
import { readChatGPTRecoverySettings } from "../../chatGPTRecoverySettings";
import {
  advanceRecoveryExperiment,
  observedRecoveryWorkload,
  readRecoveryExperiment,
  recoveryOpportunityCategories,
  verifiedExperimentEpisodes,
  saveRecoveryExperiment,
  suspendRecoveryExperiment,
} from "../../chatGPTRecoveryExperiment";

/** Passive outcome sampler. Never changes a guest or triggers recovery itself. */
export function ChatGPTRecoveryExperimentObserver() {
  const environmentId = usePrimaryEnvironmentId();
  useEffect(() => {
    if (!isElectron || !environmentId) return;
    const owner = randomUUID();
    const tick = () => {
      // This is observational instrumentation, not a session controller.
      // Browser storage may throw SecurityError before its methods are called.
      try {
        const state = readRecoveryExperiment();
        if (!state.enabled) {
          releaseRecoveryExperimentSampler(window.localStorage, environmentId, owner);
          return;
        }
        if (!claimRecoveryExperimentSampler(window.localStorage, environmentId, owner, Date.now()))
          return;
        const now = Date.now();
        if (readChatGPTRecoverySettings().paused) {
          const suspended = suspendRecoveryExperiment(state, now);
          if (suspended !== state) saveRecoveryExperiment(suspended);
          return;
        }
        const result = readChatGPTRecoveryMetrics(environmentId);
        // The recovery ledger records observation gaps and truncation. Never
        // score a partial or unobserved outcome as a cadence success/failure.
        const episodes = verifiedExperimentEpisodes(
          result.ledger?.episodes ?? [],
          result.ledger?.observation,
          now,
        );
        // Only fresh page activity observations count towards the workload
        // proxy. Missing/stale probes mean unknown, not zero active sessions.
        const registered = readChatGPTBrowserSessions(environmentId);
        const snapshotBySession = getChatGPTSessionPersistedStore(environmentId).getState().snapshots;
        const snapshots = registered.flatMap(session => {
          const raw = snapshotBySession[session.id];
          if (!raw || typeof raw !== "object") return [];
          const snapshot = raw as { activity?: unknown; observedAt?: unknown };
          return [{
            ...(typeof snapshot.activity === "string" ? { activity: snapshot.activity } : {}),
            ...(typeof snapshot.observedAt === "number" ? { observedAt: snapshot.observedAt } : {}),
          }];
        });
        // Include *all* registered sessions in the possible account load.
        // A missing or stale observation might still be generating server-side.
        const activeGuestCount = observedRecoveryWorkload(snapshots, now, registered.length);
        // No red/orange recovery opportunity means no valid trial exposure.
        // A newly closed episode still qualifies so its final sampler interval
        // is counted even after the guest becomes healthy.
        const opportunityLanes = recoveryOpportunityCategories(
          episodes,
          state.lastEvaluatedAt,
          now,
        );
        const next = advanceRecoveryExperiment(
          state,
          episodes,
          activeGuestCount,
          now,
          opportunityLanes.length > 0,
          opportunityLanes,
        );
        if (JSON.stringify(next) !== JSON.stringify(state)) saveRecoveryExperiment(next);
      } catch {
        // Never let a passive sampler disrupt the active T3 session host.
        // A lease expires naturally if storage remains inaccessible.
      }
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => {
      clearInterval(timer);
      try {
        releaseRecoveryExperimentSampler(window.localStorage, environmentId, owner);
      } catch {
        /* A denied storage getter is already outside our control. */
      }
    };
  }, [environmentId]);
  return null;
}
