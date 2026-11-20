import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

// The OmniHub mobile bridge consumes only quota metadata, never provider credentials.
export const layer = HttpRouter.add(
  "GET",
  "/api/omni/usage",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const refresh = HttpServerRequest.toURL(request);
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const sources = yield* UsageLimitSources.UsageLimitSources;
    if (refresh._tag === "Some" && refresh.value.searchParams.get("refresh") === "1") {
      yield* sources.refresh;
      yield* providers.refresh();
    }
    const firstParty = (yield* providers.getProviders)
      .filter((provider) => provider.usageLimits !== undefined)
      .map((provider) => ({
        name: provider.displayName ?? provider.driver,
        driver: provider.driver,
        instanceId: provider.instanceId,
        checkedAt: provider.usageLimits!.checkedAt,
        windows: provider.usageLimits!.windows,
        resetCredits: provider.usageLimits!.resetCredits,
        unavailable: provider.usageLimits!.unavailable,
      }));
    const external = (yield* sources.current).flatMap((source) =>
      source.accounts.map((account) => ({
        name: source.label,
        driver: account.driver,
        instanceId: account.id,
        checkedAt: account.usageLimits.checkedAt,
        windows: account.usageLimits.windows,
        resetCredits: account.usageLimits.resetCredits,
        unavailable: account.usageLimits.unavailable,
      })),
    );
    return HttpServerResponse.jsonUnsafe(
      { accounts: [...firstParty, ...external] },
      { headers: { "cache-control": "no-store" } },
    );
  }),
);
