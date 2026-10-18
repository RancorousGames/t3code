import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ServerSettings } from "@t3tools/contracts";

import { applyServerSettingsPatch } from "./serverSettings.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const projectId = ProjectId.make("p1");
const encode = Schema.encodeSync(Schema.fromJsonString(ServerSettings));
const decode = Schema.decodeSync(Schema.fromJsonString(ServerSettings));

describe("provider reset wakeups settings persistence", () => {
  it("round trips armed, queued, and completed resets through server settings", () => {
    const armed = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerResetWakeups: {
        [codex]: {
          enabled: true,
          projectId,
          armedResetAt: "2026-10-13T20:00:00.000Z",
          queued: { text: "Ship it", model: "gpt-6-astra" },
        },
      },
    });
    const encoded = encode(armed);
    const restored = decode(encoded);
    expect(restored.providerResetWakeups[codex]).toEqual(armed.providerResetWakeups[codex]);
    expect(restored.providerResetWakeups[codex]?.queued?.text).toBe("Ship it");
  });

  it("patches each provider atomically, allowing queued messages to clear without dropping others", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerResetWakeups: {
        [codex]: {
          enabled: true,
          projectId,
          queued: { text: "Build" },
          armedResetAt: "2026-10-13T20:00:00.000Z",
        },
        [claude]: { enabled: true, projectId },
      },
    });
    const changed = applyServerSettingsPatch(initial, {
      providerResetWakeups: {
        [codex]: {
          enabled: true,
          projectId,
          lastTriggeredResetAt: "2026-10-13T20:00:00.000Z",
        },
      },
    });
    expect(changed.providerResetWakeups[codex]?.queued).toBeUndefined();
    expect(changed.providerResetWakeups[claude]).toEqual(initial.providerResetWakeups[claude]);
    const removed = applyServerSettingsPatch(changed, {
      providerResetWakeups: { [codex]: null },
    });
    expect(removed.providerResetWakeups[codex]).toBeUndefined();
    expect(removed.providerResetWakeups[claude]).toEqual(initial.providerResetWakeups[claude]);
  });
});
