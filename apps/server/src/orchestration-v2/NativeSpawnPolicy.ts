import { isProviderAvailable, type ModelSelection, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class NativeSpawnApprovalUnavailable extends Schema.TaggedError<NativeSpawnApprovalUnavailable>()(
  "NativeSpawnApprovalUnavailable",
  { operationId: Schema.String },
) {
  override get message(): string {
    return "Native session creation is held until authenticated, single-use human spawn approval is available.";
  }
}

/**
 * Catalog eligibility is NOT approval or an execution authorization. It can
 * only consume a T3-owned ProviderRegistry snapshot, not an agent-supplied
 * provider object. The eventual executor must also bind effective provider
 * defaults, project enablement, caller identity, first-message and workspace
 * receipts, and obtain an ONLINE single-use reservation before side effects.
 */
export type NativeSpawnCatalogAssessment =
  | "unverified-target"
  | "human-approval-required"
  | "exact-luna-candidate";

export function assessNativeSpawnCatalogTarget(input: {
  readonly executionEnvironmentId: string;
  readonly catalogEnvironmentId: string;
  readonly selection: ModelSelection;
  readonly provider: ServerProvider | undefined;
  readonly orchestrationAdapterRegistered: boolean;
  readonly enabledForProject: boolean;
}): NativeSpawnCatalogAssessment {
  const { provider, selection } = input;
  if (
    input.executionEnvironmentId !== input.catalogEnvironmentId ||
    !provider ||
    provider.instanceId !== selection.instanceId ||
    !input.orchestrationAdapterRegistered ||
    !input.enabledForProject ||
    provider.enabled !== true ||
    provider.installed !== true ||
    provider.status !== "ready" ||
    provider.auth.status !== "authenticated" ||
    !isProviderAvailable(provider) ||
    !provider.models.some((model) => model.slug === selection.model)
  ) {
    return "unverified-target";
  }

  // An explicit option is only known to the catalog when its descriptor is
  // present and its value matches. This is NOT resolution of provider defaults.
  if (selection.options !== undefined) {
    const descriptors = provider.models.find((model) => model.slug === selection.model)
      ?.capabilities?.optionDescriptors;
    if (!descriptors) return "unverified-target";
    const seen = new Set<string>();
    for (const option of selection.options) {
      const descriptor = descriptors.find((item) => item.id === option.id);
      if (!descriptor || seen.has(option.id)) return "unverified-target";
      seen.add(option.id);
      if (
        (descriptor.type === "boolean" && typeof option.value !== "boolean") ||
        (descriptor.type === "select" &&
          !descriptor.options.some((choice) => choice.id === option.value))
      ) {
        return "unverified-target";
      }
    }
  }

  return provider.driver === "codex" && selection.model === "gpt-6-luna"
    ? "exact-luna-candidate"
    : "human-approval-required";
}

export const NATIVE_SPAWN_APPROVAL_HOLD_CONSTRAINT =
  "Native creation is held pending authenticated single-use approval/reservation, including exact Luna until the trusted verifier is connected.";

// This is a hold, not an approval verifier. No actor/model/transport field can
// bypass it. Replace only with the online canonical reservation authority.
export const holdNativeSpawn = (
  operationId: string,
): Effect.Effect<void, NativeSpawnApprovalUnavailable> =>
  Effect.fail(new NativeSpawnApprovalUnavailable({ operationId }));
