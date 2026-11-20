import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import { isDesktopQuotaSnapshot, readDesktopQuotaSnapshot, writeDesktopQuotaSnapshot } from "./OmniQuotaHistory.ts";

// The OmniHub mobile bridge consumes only quota metadata, never provider credentials.


/** Desktop-owned quota history, published by the actual desktop widget (not sampled on Android). */
export const layerDesktopQuotaHistory = HttpRouter.add(
  "POST",
  "/api/omni/usage/history",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const host = request.headers.host ?? "";
    const origin = request.headers.origin;
    const loopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
    const sameOrigin = origin === "http://" + host || origin === "https://" + host;
    if (!(sameOrigin || DESKTOP_RENDERER_ORIGINS.some((known) => known === origin) ||
          (!origin && loopback) || origin === config.devUrl?.origin)) {
      return HttpServerResponse.jsonUnsafe({ error: "Untrusted quota history origin" }, { status: 403 });
    }
    if (Number(request.headers["content-length"] ?? "0") > 128 * 1024) {
      return HttpServerResponse.jsonUnsafe({ error: "Quota history exceeds limit" }, { status: 413 });
    }
    const parsed = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(128 * 1024)),
      Effect.result,
    );
    const snapshot = parsed._tag === "Success" ? parsed.success : null;
    if (!isDesktopQuotaSnapshot(snapshot)) {
      return HttpServerResponse.jsonUnsafe({ error: "Invalid desktop quota history" }, { status: 400 });
    }
    const written = yield* Effect.tryPromise(() =>
      writeDesktopQuotaSnapshot(config.stateDir, snapshot)).pipe(Effect.result);
    return written._tag === "Success"
      ? HttpServerResponse.jsonUnsafe({ ok: true }, { headers: { "cache-control": "no-store" } })
      : HttpServerResponse.jsonUnsafe({ error: "Could not save desktop quota history" }, { status: 500 });
  }),
);

export const layer = HttpRouter.add(
  "GET",
  "/api/omni/usage",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const refresh = HttpServerRequest.toURL(request);
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const sources = yield* UsageLimitSources.UsageLimitSources;
    const config = yield* ServerConfig.ServerConfig;
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
    const quotaPacing = yield* Effect.tryPromise(() => readDesktopQuotaSnapshot(config.stateDir))
      .pipe(Effect.orElseSucceed(() => null));
    return HttpServerResponse.jsonUnsafe(
      { accounts: [...firstParty, ...external], quotaPacing },
      { headers: { "cache-control": "no-store" } },
    );
  }),
);
