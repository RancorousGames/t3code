/**
 * Start a new provider quota window with a minimal message, or deliver an
 * explicitly queued user job instead. The schedule is server-owned, durable in
 * settings.json, and swept on startup and by the shared 5-second scheduler.
 * No renderer or connected browser is required.
 */
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderResetWakeup,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";

const FIVE_HOUR_MINUTES = 300;
const RETRY_DELAY_MS = 60_000;
const PROVIDER_STARTUP_GRACE_MS = 45_000;
const HELLO = "Say 'hello'.";

/** Do not treat a weekly/monthly window as a session reset. */
export function fiveHourReset(provider: ServerProvider): string | null {
  if (provider.driver !== "codex" && provider.driver !== "claudeAgent") return null;
  const window = provider.usageLimits?.windows.find(
    (entry: ServerProviderUsageWindow) =>
      entry.windowDurationMins === FIVE_HOUR_MINUTES ||
      (provider.driver === "claudeAgent" && entry.id === "five_hour"),
  );
  if (!window?.resetsAt || !Number.isFinite(Date.parse(window.resetsAt))) return null;
  return window.resetsAt;
}

/** Select only an advertised low-cost model; never silently fall back to Opus/Astra. */
export function inexpensiveWakeSelection(provider: ServerProvider): ModelSelection | null {
  const token =
    provider.driver === "claudeAgent" ? "haiku" : provider.driver === "codex" ? "luna" : null;
  if (!token) return null;
  const candidates = provider.models.filter((model) => model.slug.toLowerCase().includes(token));
  // Prefer current models, but permit a legacy cheap family member rather
  // than silently falling back to a much more expensive model.
  const ranked = candidates.sort(
    (a, b) =>
      Number(Boolean(a.isLegacy)) - Number(Boolean(b.isLegacy)) ||
      b.slug.localeCompare(a.slug, undefined, { numeric: true }),
  );
  const chosen = ranked[0];
  if (!chosen) {
    // Unauthenticated or not-yet-probed accounts often have an empty model
    // snapshot. Try the known cheap model from T3's bundled provider catalog
    // and let the actual provider launch validate availability/credentials.
    return provider.driver === "codex"
      ? {
          instanceId: provider.instanceId,
          model: "gpt-6-luna",
          options: [{ id: "reasoningEffort", value: "low" }],
        }
      : {
          instanceId: provider.instanceId,
          model: "claude-haiku-5-5",
          options: [{ id: "effort", value: "low" }],
        };
  }
  const effort = chosen.capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === "select" &&
      (option.id === "reasoningEffort" || option.id === "effort") &&
      option.options.some((choice) => choice.id === "low"),
  );
  return {
    instanceId: provider.instanceId,
    model: chosen.slug,
    ...(effort ? { options: [{ id: effort.id, value: "low" }] } : {}),
  };
}

export type ResetWakeDecision =
  | { readonly type: "none" }
  | { readonly type: "arm"; readonly resetAt: string }
  | {
      readonly type: "dispatch";
      readonly resetAt: string;
      readonly text: string;
      readonly model: string | undefined;
      readonly testOnly?: boolean;
    };

export function resetWakeDecision(
  config: ProviderResetWakeup,
  reportedResetAt: string | null,
  nowMs: number,
): ResetWakeDecision {
  if (config.testRequestedAt) {
    return {
      type: "dispatch",
      resetAt: `test:${config.testRequestedAt}`,
      text: HELLO,
      model: undefined,
      testOnly: true,
    };
  }
  if (!config.enabled) return { type: "none" };
  const armed = config.armedResetAt;
  const due = armed ? Date.parse(armed) : NaN;
  if (Number.isFinite(due) && due <= nowMs && config.lastTriggeredResetAt !== armed) {
    return {
      type: "dispatch",
      resetAt: armed!,
      text: config.queued?.text ?? HELLO,
      model: config.queued?.model,
    };
  }
  const reportedMs = reportedResetAt ? Date.parse(reportedResetAt) : NaN;
  if (
    Number.isFinite(reportedMs) &&
    reportedMs > nowMs &&
    reportedResetAt !== armed &&
    // A new provider snapshot may advance to the following reset before
    // the previous armed one was dispatched. Never overwrite an overdue job.
    !(Number.isFinite(due) && due <= nowMs && config.lastTriggeredResetAt !== armed)
  )
    return { type: "arm", resetAt: reportedResetAt! };
  return { type: "none" };
}

export const makeSweep = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  // The wake worker can receive a separately constructed settings layer.
  // Without start(), that instance's cache is loaded once and never sees
  // changes made by the UI's settings service. start() is idempotent.
  yield* settings.start;
  const threads = yield* ThreadLaunch.ThreadLaunchService;
  const retryAfter = yield* Ref.make(new Map<string, number>());
  const nextProbeAfter = yield* Ref.make(new Map<string, number>());
  const loggedTest = yield* Ref.make(new Set<string>());
  const lastConfigSignature = yield* Ref.make<string | null>(null);
  const unavailableSince = yield* Ref.make(new Map<string, number>());

  const finishTest = Effect.fn("ProviderResetWakeWorker.finishTest")(function* (
    instanceId: string,
    requestedAt: string,
    status: "succeeded" | "failed",
    message: string,
    threadId?: string,
  ) {
    const latest = (yield* settings.getSettings).providerResetWakeups[
      ProviderInstanceId.make(instanceId)
    ];
    if (latest?.testRequestedAt !== requestedAt) return;
    const { testRequestedAt: _completed, ...rest } = latest;
    yield* settings.updateSettings({
      providerResetWakeups: {
        [instanceId]: {
          ...rest,
          lastTestResult: { requestedAt, status, message, ...(threadId ? { threadId } : {}) },
        },
      },
    });
  });

  return Effect.fn("ProviderResetWakeWorker.sweep")(function* () {
    const current = yield* settings.getSettings;
    const configured = Object.entries(current.providerResetWakeups).filter(
      ([, value]) => value.enabled || value.testRequestedAt !== undefined,
    );
    const signature = Object.entries(current.providerResetWakeups)
      .map(([id, wake]) => `${id}:${wake.enabled}:${Boolean(wake.testRequestedAt)}`)
      .join("|");
    if ((yield* Ref.get(lastConfigSignature)) !== signature) {
      yield* Ref.set(lastConfigSignature, signature);
      yield* Effect.logInfo("Provider reset wake settings snapshot", {
        configured: configured.length,
        entries: signature,
      });
    }
    if (configured.length === 0) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const providers = yield* registry.getProviders;
    for (const [id, config] of configured) {
      const provider = providers.find((entry) => entry.instanceId === id);
      if (config.testRequestedAt) {
        const key = `${id}:${config.testRequestedAt}`;
        const seen = yield* Ref.get(loggedTest);
        if (!seen.has(key)) {
          yield* Ref.update(loggedTest, (previous) => new Set(previous).add(key));
          yield* Effect.logInfo("Provider reset wake test received", {
            instanceId: id,
            available: provider !== undefined,
            providerEnabled: provider?.enabled,
            installed: provider?.installed,
            authentication: provider?.auth.status,
          });
        }
      }
      if (!provider?.enabled || !provider.installed) {
        // Initial registry hydration is asynchronous. A main account may be
        // missing for the first several scheduler ticks after startup. Do not
        // mark an explicit test as failed before that account has a chance to
        // appear; retain the durable request for a later sweep.
        const unavailable = yield* Ref.get(unavailableSince);
        const firstMissing = unavailable.get(id) ?? nowMs;
        if (!unavailable.has(id)) {
          yield* Ref.update(unavailableSince, (previous) =>
            new Map(previous).set(id, firstMissing),
          );
        }
        if (config.testRequestedAt && nowMs - firstMissing >= PROVIDER_STARTUP_GRACE_MS) {
          yield* finishTest(
            id,
            config.testRequestedAt,
            "failed",
            "Provider is disabled, missing, or not installed.",
          );
        }
        continue;
      }
      yield* Ref.update(unavailableSince, (previous) => {
        if (!previous.has(id)) return previous;
        const next = new Map(previous);
        next.delete(id);
        return next;
      });
      // Authentication probes can report unauthenticated for usable custom
      // homes. Attempt the thread launch; the driver is the authority on
      // whether its actual credentials can start a turn.
      const reportedResetAt = fiveHourReset(provider);
      let decision = resetWakeDecision(config, reportedResetAt, nowMs);
      if (
        decision.type === "none" &&
        config.enabled &&
        (!reportedResetAt || Date.parse(reportedResetAt) <= nowMs) &&
        ((yield* Ref.get(nextProbeAfter)).get(id) ?? 0) <= nowMs
      ) {
        // Background provider health refresh may be paused on a locked or
        // sleeping host. An armed reset still fires from disk, but a new
        // five-hour deadline must be rediscovered without an open client.
        yield* Ref.update(nextProbeAfter, (previous) =>
          new Map(previous).set(id, nowMs + 5 * 60_000),
        );
        const refreshed = yield* Effect.exit(registry.refreshInstance(provider.instanceId));
        if (refreshed._tag === "Success") {
          const currentProvider = refreshed.value.find((entry) => entry.instanceId === id);
          if (currentProvider) {
            decision = resetWakeDecision(config, fiveHourReset(currentProvider), nowMs);
          }
        } else {
          yield* Effect.logWarning("provider reset probe failed", {
            instanceId: id,
            cause: refreshed.cause,
          });
        }
      }
      if (decision.type === "none") continue;
      if (decision.type === "arm") {
        yield* settings
          .updateSettings({
            providerResetWakeups: { [id]: { ...config, armedResetAt: decision.resetAt } },
          })
          .pipe(Effect.asVoid);
        continue;
      }

      const key = `${id}:${decision.resetAt}`;
      if ((yield* Ref.get(retryAfter)).get(key)! > nowMs) continue;
      const base = inexpensiveWakeSelection(provider);
      // A normal queued job may pick a different model; a wake-only job
      // must use one of the inexpensive, actually available models.
      const model = decision.model
        ? provider.models.find((item) => item.slug === decision.model)
        : undefined;
      const selection: ModelSelection | null = model
        ? { instanceId: provider.instanceId, model: model.slug }
        : decision.model
          ? null
          : base;
      if (!selection) {
        yield* Ref.update(retryAfter, (previous) =>
          new Map(previous).set(key, nowMs + RETRY_DELAY_MS),
        );
        yield* Effect.logWarning("reset wake has no available requested model", {
          instanceId: id,
          requestedModel: decision.model,
        });
        if (decision.testOnly && config.testRequestedAt) {
          yield* finishTest(
            id,
            config.testRequestedAt,
            "failed",
            decision.model
              ? "The requested model is unavailable."
              : "No Luna or Haiku model is available for this provider.",
          );
        }
        continue;
      }
      const sent = yield* Effect.exit(
        threads.launch({
          commandId: CommandId.make(`reset-wake:${key}`),
          projectId: config.projectId,
          // Test and user-queued jobs remain inspectable; only unattended hello
          // threads are eligible for the automatic post-reply cleanup.
          title: decision.testOnly
            ? "5-hour wake test"
            : config.queued
              ? "Queued at provider reset"
              : "5-hour session wake",
          generateTitle: false,
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make(`reset-wake:${key}`),
            text: decision.text,
            attachments: [],
          },
          createdBy: "user",
          creationSource: "server",
        }),
      );
      if (sent._tag === "Failure") {
        yield* Ref.update(retryAfter, (previous) =>
          new Map(previous).set(key, nowMs + RETRY_DELAY_MS),
        );
        yield* Effect.logWarning("provider reset wake could not dispatch", {
          instanceId: id,
          resetAt: decision.resetAt,
          cause: sent.cause,
        });
        if (decision.testOnly && config.testRequestedAt) {
          yield* finishTest(
            id,
            config.testRequestedAt,
            "failed",
            "T3 could not create the test thread. Check provider sign-in and the selected workspace.",
          );
        }
        continue;
      }
      // Record after successful dispatch; deterministic command ID prevents
      // duplicates if the server crashes between dispatch and persistence.
      // Re-read after launch: the user may have edited the next job or
      // disabled wakeups while this provider was starting its new thread.
      const latest = (yield* settings.getSettings).providerResetWakeups[
        ProviderInstanceId.make(id)
      ];
      if (!latest) continue;
      const nextResetAt =
        reportedResetAt && Date.parse(reportedResetAt) > nowMs ? reportedResetAt : undefined;
      let next: ProviderResetWakeup;
      if (decision.testOnly) {
        if (config.testRequestedAt) {
          yield* finishTest(
            id,
            config.testRequestedAt,
            "succeeded",
            "Test thread created. Open it to check the provider's response.",
            sent.value.threadId,
          );
        }
        continue;
      } else {
        const { queued: _dispatched, ...withoutQueue } = latest;
        const queueChanged =
          latest.queued?.text !== config.queued?.text ||
          latest.queued?.model !== config.queued?.model;
        const existingFutureReset =
          latest.armedResetAt && Date.parse(latest.armedResetAt) > nowMs
            ? latest.armedResetAt
            : undefined;
        next = {
          ...withoutQueue,
          lastTriggeredResetAt: decision.resetAt,
          armedResetAt: existingFutureReset ?? nextResetAt ?? decision.resetAt,
          ...(queueChanged && latest.queued ? { queued: latest.queued } : {}),
        };
      }
      yield* settings
        .updateSettings({
          providerResetWakeups: { [id]: next },
        })
        .pipe(Effect.asVoid);
    }
  });
});

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("provider-reset-wake", sweep());
  }),
);
