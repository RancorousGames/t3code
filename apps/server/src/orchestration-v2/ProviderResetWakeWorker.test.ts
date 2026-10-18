// @effect-diagnostics globalDate:off -- Integration test fixtures need wall-clock timestamps.
import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
} from "../provider/ClaudeModelCatalog.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderResetWakeup,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

import {
  fiveHourReset,
  inexpensiveWakeSelection,
  resetWakeDecision,
  makeSweep,
} from "./ProviderResetWakeWorker.ts";

const now = Date.parse("2026-10-13T16:00:00.000Z");
const reset = "2026-10-13T16:00:00.000Z";
const future = "2026-10-13T21:00:00.000Z";
const earlier = "2026-10-13T15:00:00.000Z";
const projectId = ProjectId.make("project_test");

function config(override: Partial<ProviderResetWakeup> = {}): ProviderResetWakeup {
  return { enabled: true, projectId, ...override };
}

function provider(
  driver: "codex" | "claudeAgent",
  windows: readonly {
    id: string;
    resetsAt?: string;
    windowDurationMins?: number;
  }[] = [],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    status: "ready",
    checkedAt: reset,
    models: [],
    usageLimits: {
      checkedAt: reset,
      windows: windows.map((window) => ({
        ...window,
        kind: "session",
        label: "Session",
        usedPercent: 30,
      })),
    },
  } as unknown as ServerProvider;
}

describe("provider 5-hour reset wake decisions", () => {
  it("arms a future window exactly once", () => {
    expect(resetWakeDecision(config(), future, now)).toEqual({
      type: "arm",
      resetAt: future,
    });
    expect(resetWakeDecision(config({ armedResetAt: future }), future, now)).toEqual({
      type: "none",
    });
  });

  it("dispatches an overdue, persisted reset immediately on startup", () => {
    expect(resetWakeDecision(config({ armedResetAt: earlier }), future, now)).toEqual({
      type: "dispatch",
      resetAt: earlier,
      text: "Say 'hello'.",
      model: undefined,
    });
  });

  it("sends an explicitly queued job instead of the hello prompt", () => {
    expect(
      resetWakeDecision(
        config({
          armedResetAt: earlier,
          queued: { text: "Build the new feature", model: "gpt-6-astra" },
        }),
        null,
        now,
      ),
    ).toEqual({
      type: "dispatch",
      resetAt: earlier,
      text: "Build the new feature",
      model: "gpt-6-astra",
    });
  });

  it("never duplicates a dispatched reset or silently replaces it with a newer window", () => {
    expect(
      resetWakeDecision(
        config({
          armedResetAt: earlier,
          lastTriggeredResetAt: earlier,
        }),
        earlier,
        now,
      ),
    ).toEqual({ type: "none" });
    expect(
      resetWakeDecision(
        config({
          armedResetAt: earlier,
          lastTriggeredResetAt: earlier,
        }),
        future,
        now,
      ),
    ).toEqual({ type: "arm", resetAt: future });
    expect(resetWakeDecision(config({ armedResetAt: earlier }), future, now).type).toBe("dispatch");
  });

  it("lets the user send a test hello immediately without consuming the queued next-reset job", () => {
    expect(
      resetWakeDecision(
        config({
          enabled: false,
          armedResetAt: future,
          queued: { text: "Start nightly work" },
          testRequestedAt: "2026-10-13T15:59:00Z",
        }),
        future,
        now,
      ),
    ).toEqual({
      type: "dispatch",
      resetAt: "test:2026-10-13T15:59:00Z",
      text: "Say 'hello'.",
      model: undefined,
      testOnly: true,
    });
  });

  it("does not dispatch disabled or unknown reset windows", () => {
    expect(
      resetWakeDecision(config({ enabled: false, armedResetAt: earlier }), future, now),
    ).toEqual({ type: "none" });
    expect(resetWakeDecision(config(), null, now)).toEqual({ type: "none" });
    expect(resetWakeDecision(config({ armedResetAt: "not-a-date" }), future, now)).toEqual({
      type: "arm",
      resetAt: future,
    });
  });
});

describe("five-hour quota provider and cheap model resolution", () => {
  it("ignores weekly resets for Codex and handles Claude's five_hour window", () => {
    expect(
      fiveHourReset(
        provider("codex", [
          { id: "secondary", resetsAt: future, windowDurationMins: 10080 },
          { id: "primary", resetsAt: reset, windowDurationMins: 300 },
        ]),
      ),
    ).toBe(reset);
    expect(fiveHourReset(provider("claudeAgent", [{ id: "five_hour", resetsAt: future }]))).toBe(
      future,
    );
    expect(
      fiveHourReset(
        provider("codex", [{ id: "secondary", resetsAt: future, windowDurationMins: 10080 }]),
      ),
    ).toBeNull();
  });

  it("selects the newest advertised Luna or Haiku and requests low effort", () => {
    const codex = provider("codex");
    const options = [
      {
        id: "reasoningEffort",
        type: "select" as const,
        label: "Effort",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ];
    const selection = inexpensiveWakeSelection({
      ...codex,
      models: [
        {
          slug: "gpt-5.6-luna",
          name: "Luna",
          isCustom: false,
          capabilities: { optionDescriptors: options },
        },
        {
          slug: "gpt-6-luna",
          name: "Luna 6",
          isCustom: false,
          capabilities: { optionDescriptors: options },
        },
        { slug: "gpt-6-astra", name: "Astra", isCustom: false, capabilities: null },
      ],
    });
    expect(selection).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });

    const claude = provider("claudeAgent");
    expect(
      inexpensiveWakeSelection({
        ...claude,
        models: [
          { slug: "claude-haiku-4-5", name: "Haiku 4.5", isCustom: false, capabilities: null },
          {
            slug: "claude-haiku-5-5",
            name: "Haiku 5.5",
            isCustom: false,
            capabilities: getClaudeCatalogModelCapabilities(
              BUNDLED_CLAUDE_MODEL_CATALOG,
              "claude-haiku-5-5",
            ),
          },
        ],
      })?.model,
    ).toBe("claude-haiku-5-5");
    expect(
      inexpensiveWakeSelection({
        ...claude,
        models: [
          {
            slug: "claude-haiku-5-5",
            name: "Haiku 5.5",
            isCustom: false,
            capabilities: getClaudeCatalogModelCapabilities(
              BUNDLED_CLAUDE_MODEL_CATALOG,
              "claude-haiku-5-5",
            ),
          },
        ],
      }),
    ).toEqual({
      instanceId: claude.instanceId,
      model: "claude-haiku-5-5",
      options: [{ id: "effort", value: "low" }],
    });
    expect(inexpensiveWakeSelection({ ...claude, models: [] })).toEqual({
      instanceId: claude.instanceId,
      model: "claude-haiku-5-5",
      options: [{ id: "effort", value: "low" }],
    });
    expect(inexpensiveWakeSelection({ ...codex, models: [] })).toEqual({
      instanceId: codex.instanceId,
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });
});

describe("reset wake startup recovery", () => {
  effectIt.effect("delivers an overdue queued job once and records completion durably", () =>
    Effect.gen(function* () {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const overdue = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 60_000));
      const upcoming = DateTime.formatIso(DateTime.makeUnsafe(nowMs + 4 * 60 * 60_000));
      const providerSnapshot = {
        ...provider("codex", [{ id: "primary", windowDurationMins: 300, resetsAt: upcoming }]),
        models: [
          {
            slug: "gpt-6-luna",
            name: "Luna 6",
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  type: "select" as const,
                  label: "Effort",
                  options: [{ id: "low", label: "Low" }],
                },
              ],
            },
          },
        ],
      };
      let persisted = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        providerResetWakeups: {
          [providerSnapshot.instanceId]: config({
            armedResetAt: overdue,
            queued: { text: "Work on the nightly build." },
          }),
        },
      });
      const updateSettings = vi.fn((patch: ServerSettingsPatch) =>
        Effect.sync(() => {
          persisted = applyServerSettingsPatch(persisted, patch);
          return persisted;
        }),
      );
      const launch = vi.fn((_input: ThreadLaunch.ThreadLaunchInput) =>
        Effect.succeed({ threadId: "wake-thread", resumed: false }),
      );
      const layer = Layer.mergeAll(
        Layer.succeed(
          ProviderRegistry.ProviderRegistry,
          ProviderRegistry.ProviderRegistry.of({
            getProviders: Effect.succeed([providerSnapshot]),
          } as never),
        ),
        Layer.succeed(
          ServerSettings.ServerSettingsService,
          ServerSettings.ServerSettingsService.of({
            start: Effect.void,
            getSettings: Effect.sync(() => persisted),
            updateSettings,
          } as never),
        ),
        Layer.succeed(
          ThreadLaunch.ThreadLaunchService,
          ThreadLaunch.ThreadLaunchService.of({
            launch,
          } as never),
        ),
      );
      yield* Effect.gen(function* () {
        const sweep = yield* makeSweep;
        yield* sweep();
        yield* sweep();
      }).pipe(Effect.provide(layer));

      expect(launch).toHaveBeenCalledOnce();
      const request = launch.mock.calls[0]?.[0] as unknown as ThreadLaunch.ThreadLaunchInput;
      expect(request.initialMessage?.text).toBe("Work on the nightly build.");
      expect(request.modelSelection).toEqual({
        instanceId: providerSnapshot.instanceId,
        model: "gpt-6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      });
      expect(
        persisted.providerResetWakeups[providerSnapshot.instanceId]?.lastTriggeredResetAt,
      ).toBe(overdue);
      expect(persisted.providerResetWakeups[providerSnapshot.instanceId]?.queued).toBeUndefined();
      expect(persisted.providerResetWakeups[providerSnapshot.instanceId]?.armedResetAt).toBe(
        upcoming,
      );
    }),
  );
});

describe("test hello dispatch reliability", () => {
  for (const succeeds of [true, false]) {
    effectIt.effect(
      succeeds
        ? "dispatches on an unauthenticated probe and records a visible success"
        : "records a visible failure instead of leaving the test pending",
      () =>
        Effect.gen(function* () {
          const requestedAt = "2026-10-13T15:23:04.184Z";
          const currentProvider = {
            ...provider("codex"),
            auth: { status: "unauthenticated" as const },
            models: [],
          };
          let persisted = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
            providerResetWakeups: {
              [currentProvider.instanceId]: config({
                enabled: false,
                testRequestedAt: requestedAt,
              }),
            },
          });
          const launch = vi.fn((_input: ThreadLaunch.ThreadLaunchInput) =>
            succeeds
              ? Effect.succeed({ threadId: "wake-test", resumed: false })
              : Effect.die("provider rejected test"),
          );
          const layer = Layer.mergeAll(
            Layer.succeed(
              ProviderRegistry.ProviderRegistry,
              ProviderRegistry.ProviderRegistry.of({
                getProviders: Effect.succeed([currentProvider]),
              } as never),
            ),
            Layer.succeed(
              ServerSettings.ServerSettingsService,
              ServerSettings.ServerSettingsService.of({
                start: Effect.void,
                getSettings: Effect.sync(() => persisted),
                updateSettings: (patch: ServerSettingsPatch) =>
                  Effect.sync(() => {
                    persisted = applyServerSettingsPatch(persisted, patch);
                    return persisted;
                  }),
              } as never),
            ),
            Layer.succeed(
              ThreadLaunch.ThreadLaunchService,
              ThreadLaunch.ThreadLaunchService.of({ launch } as never),
            ),
          );
          yield* Effect.gen(function* () {
            const sweep = yield* makeSweep;
            yield* sweep();
            yield* sweep();
          }).pipe(Effect.provide(layer));
          expect(launch).toHaveBeenCalledTimes(1);
          const wake = persisted.providerResetWakeups[currentProvider.instanceId];
          expect(wake?.testRequestedAt).toBeUndefined();
          expect(wake?.enabled).toBe(false);
          expect(wake?.lastTestResult?.requestedAt).toBe(requestedAt);
          expect(wake?.lastTestResult?.status).toBe(succeeds ? "succeeded" : "failed");
          expect(wake?.lastTestResult?.threadId).toBe(succeeds ? "wake-test" : undefined);
        }),
    );
  }
});

describe("default provider hydration during startup", () => {
  effectIt.effect(
    "waits for the main Codex account to become available before launching a test",
    () =>
      Effect.gen(function* () {
        const primary = provider("codex");
        let hydrated = false;
        let settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          providerResetWakeups: {
            [primary.instanceId]: config({
              enabled: true,
              testRequestedAt: "2026-10-13T16:22:00.000Z",
            }),
          },
        });
        const launch = vi.fn((_input: ThreadLaunch.ThreadLaunchInput) =>
          Effect.succeed({ threadId: "main-codex-thread", resumed: false }),
        );
        const services = Layer.mergeAll(
          Layer.succeed(
            ProviderRegistry.ProviderRegistry,
            ProviderRegistry.ProviderRegistry.of({
              getProviders: Effect.sync(() => (hydrated ? [primary] : [])),
              refreshInstance: () => Effect.succeed(hydrated ? [primary] : []),
            } as never),
          ),
          Layer.succeed(
            ServerSettings.ServerSettingsService,
            ServerSettings.ServerSettingsService.of({
              start: Effect.void,
              getSettings: Effect.sync(() => settings),
              updateSettings: (patch: ServerSettingsPatch) =>
                Effect.sync(() => {
                  settings = applyServerSettingsPatch(settings, patch);
                  return settings;
                }),
            } as never),
          ),
          Layer.succeed(
            ThreadLaunch.ThreadLaunchService,
            ThreadLaunch.ThreadLaunchService.of({ launch } as never),
          ),
        );
        yield* Effect.gen(function* () {
          const sweep = yield* makeSweep;
          yield* sweep();
          expect(launch).not.toHaveBeenCalled();
          expect(settings.providerResetWakeups[primary.instanceId]?.testRequestedAt).toBeDefined();
          hydrated = true;
          yield* sweep();
          yield* sweep();
        }).pipe(Effect.provide(services));
        expect(launch).toHaveBeenCalledOnce();
        expect(launch.mock.calls[0]?.[0]?.modelSelection.instanceId).toBe(primary.instanceId);
        expect(settings.providerResetWakeups[primary.instanceId]?.testRequestedAt).toBeUndefined();
        expect(settings.providerResetWakeups[primary.instanceId]?.lastTestResult?.status).toBe(
          "succeeded",
        );
      }),
  );
});
