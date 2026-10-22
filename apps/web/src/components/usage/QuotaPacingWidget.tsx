import { useAtomValue } from "@effect/atom-react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { collectLimitAccounts, elapsedShare, paceOf } from "@t3tools/shared/usageLimits";
import { GaugeIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type ContextWindowSnapshot,
  type PromptCacheSnapshot,
  formatContextWindowTokens,
} from "../../lib/contextWindow";
import { useChatCanvas } from "../chat/ChatCanvasContext";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  bankedResets,
  normalizeQuotaHistory,
  quotaPath,
  quotaUsedInLastHour,
  quotaWindows,
  recordQuotaSamples,
} from "./quotaPacing";
import { resetCreditsSummary } from "./UsageLimits";

const STORAGE_KEY = "t3code:quota-pacing:v1";
const HistorySchema = Schema.Record(
  Schema.String,
  Schema.Array(
    Schema.Struct({
      at: Schema.Number.check(Schema.isFinite()),
      used: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    }),
  ),
);
const COLORS = ["#4da3ff", "#ff8a3d"];
const NAMES = ["Codex", "Claude"];

function formatContextUsage(contextWindow: ContextWindowSnapshot) {
  const { usedTokens, maxTokens, usedPercentage } = contextWindow;
  if (maxTokens == null || usedPercentage === null) {
    return `${formatContextWindowTokens(usedTokens)} tokens`;
  }
  return `${Math.round(usedPercentage)}% · ${formatContextWindowTokens(usedTokens)}/${formatContextWindowTokens(maxTokens)}`;
}

function formatPromptCache(promptCache: PromptCacheSnapshot, now: number) {
  const remainingMins = (promptCache.expiresAt - now) / 60_000;
  if (remainingMins <= 0) return "cold";
  return remainingMins < 1 ? "warm · <1m left" : `warm · ${Math.floor(remainingMins)}m left`;
}

export function QuotaPacingWidget({
  contextWindow,
  promptCache,
}: {
  contextWindow?: ContextWindowSnapshot | null;
  promptCache?: PromptCacheSnapshot | null;
} = {}) {
  const canvas = useChatCanvas();
  const viewportHasRoom = useMediaQuery("(min-width: 1024px) and (min-height: 480px)");
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [history, setHistory] = useState(() => {
    try {
      return normalizeQuotaHistory(getLocalStorageItem(STORAGE_KEY, HistorySchema) ?? {});
    } catch {
      return {};
    }
  });
  const accounts = useMemo(() => collectLimitAccounts(presentations), [presentations]);
  const observedNow = Math.max(
    now,
    ...accounts.map((account) => Date.parse(account.limits.checkedAt)).filter(Number.isFinite),
  );
  const rows = useMemo(() => quotaWindows(accounts, observedNow), [accounts, observedNow]);
  const resets = useMemo(() => bankedResets(accounts), [accounts]);
  const connectedKey = Array.from(presentations)
    .filter(
      ([, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig,
    )
    .map(([id]) => id)
    .sort()
    .join(":");
  const refresh = useEffectEvent(() => {
    if (document.visibilityState === "hidden") return;
    for (const [environmentId, presentation] of presentations) {
      if (presentation.connection.phase !== "connected" || !presentation.serverConfig) continue;
      void refreshUsageLimits(
        environmentId,
        () => refreshProviders({ environmentId, input: {} }),
        true,
      ).catch(() => {});
    }
  });
  useEffect(() => {
    if (!connectedKey) return;
    refresh();
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      refresh();
    };
    const timer = window.setInterval(onVisible, 5 * 60_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connectedKey]);
  const cacheExpiresAt = promptCache?.expiresAt;
  useEffect(() => {
    // Tick once a minute while the cache countdown is visible, then once more at expiry.
    if (cacheExpiresAt === undefined || cacheExpiresAt <= now) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(60_000, cacheExpiresAt - now),
    );
    return () => window.clearTimeout(timer);
  }, [cacheExpiresAt, now]);
  useEffect(() => {
    const next = recordQuotaSamples(history, rows, observedNow);
    if (JSON.stringify(next) === JSON.stringify(history)) return;
    // Synchronize persisted observations only when a new provider snapshot arrives.
    // oxlint-disable-next-line react/set-state-in-effect
    setHistory(next);
    try {
      setLocalStorageItem(STORAGE_KEY, next, HistorySchema);
    } catch {
      /* Quota plots still work in memory when storage is unavailable. */
    }
  }, [history, rows, observedNow]);

  if (!rows.some((row) => row.series.some(Boolean))) return null;
  const hasRoom = canvas
    ? canvas.container.width - 292 >= canvas.layout.chat.left + canvas.layout.chat.width + 12 &&
      canvas.container.height >= 480 &&
      !canvas.layout.frame
    : viewportHasRoom;
  const open = expanded ?? hasRoom;

  const widget = (
    <aside
      aria-label="Quota pacing"
      className={canvas ? "absolute right-3 bottom-3 z-20" : "fixed right-3 bottom-3 z-40"}
    >
      <div
        className="dropdown-glass overflow-hidden rounded-xl border border-border/60 shadow-lg"
        style={{ width: open ? 280 : undefined }}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Collapse quota pacing" : "Expand quota pacing"}
          onClick={() => setExpanded(!open)}
          className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-2xs text-muted-foreground hover:text-foreground"
        >
          <span className="flex items-center gap-1.5">
            <GaugeIcon className="size-3" />
            Quota pacing
          </span>
          {!open && resets.some(Boolean) ? (
            <span className="flex gap-1">
              {resets.map((reset, index) =>
                reset ? (
                  <span
                    key={NAMES[index]}
                    className="flex items-center gap-1 rounded-full border px-1.5 font-semibold"
                    style={{ color: COLORS[index], borderColor: COLORS[index] }}
                  >
                    <RotateCcwIcon className="size-2.5" />
                    {NAMES[index]} reset
                  </span>
                ) : null,
              )}
            </span>
          ) : null}
          {open ? (
            <span className="flex gap-2">
              <span style={{ color: COLORS[0] }}>Codex</span>
              <span style={{ color: COLORS[1] }}>Claude</span>
            </span>
          ) : null}
          <span aria-hidden>{open ? "−" : "+"}</span>
        </button>
        {open ? (
          <div className="space-y-2 px-2 pb-2">
            <div className="flex items-center justify-between px-1 text-2xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <RotateCcwIcon className="size-3" />
                Reset available
              </span>
              <div className="flex gap-2 tabular-nums">
                {resets.map((reset, index) => (
                  <Tooltip key={NAMES[index]}>
                    <TooltipTrigger
                      render={
                        <span
                          tabIndex={0}
                          className={reset ? "rounded-full border px-1.5 font-semibold" : ""}
                          style={
                            reset ? { color: COLORS[index], borderColor: COLORS[index] } : undefined
                          }
                        />
                      }
                    >
                      {NAMES[index]} · {reset ? reset.availableCount : "none"}
                    </TooltipTrigger>
                    <TooltipPopup>
                      {NAMES[index]}:{" "}
                      {reset ? resetCreditsSummary(reset, now) : "no reset credits banked"}
                    </TooltipPopup>
                  </Tooltip>
                ))}
              </div>
            </div>
            {rows.map((row) => (
              <div key={row.label}>
                <div className="mb-1 flex items-baseline justify-between px-1">
                  <span className="text-xs font-semibold">{row.label}</span>
                  <div className="flex gap-3 text-xl leading-none font-bold tracking-tight tabular-nums">
                    {row.series.map((series, index) => (
                      <Tooltip key={NAMES[index]}>
                        <TooltipTrigger
                          render={
                            <span
                              key={NAMES[index]}
                              style={{ color: COLORS[index] }}
                              aria-label={`${NAMES[index]} ${row.label}: ${series ? `${Math.round(series.window.usedPercent)}% used` : "unavailable"}`}
                              tabIndex={0}
                            />
                          }
                        >
                          {series ? `${Math.round(series.window.usedPercent)}%` : "—"}
                        </TooltipTrigger>
                        <TooltipPopup>
                          {series
                            ? `${NAMES[index]} · ${series.account.displayName ?? series.account.email ?? "Account"} · ${paceOf(series.window, now)} pace · resets ${new Date(series.window.resetsAt!).toLocaleString()}${series.account.limits.unavailable ? " · Last available reading" : ""}`
                            : `${NAMES[index]} quota unavailable`}
                        </TooltipPopup>
                      </Tooltip>
                    ))}
                  </div>
                </div>
                <div className="mb-1 flex justify-between px-1 text-2xs tabular-nums text-muted-foreground">
                  <span>Last 1h</span>
                  <div className="flex gap-3">
                    {row.series.map((series, index) => {
                      const used = series
                        ? quotaUsedInLastHour(history[series.key] ?? [], observedNow)
                        : null;
                      return (
                        <span key={NAMES[index]} style={{ color: COLORS[index] }}>
                          {used === null ? "—" : `${used.toFixed(1)}%`}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <svg
                  viewBox="0 0 280 70"
                  className="h-[70px] w-full rounded-md border border-white bg-background/80"
                  role="img"
                  aria-label={`${row.label} usage; dashed diagonal is ideal consumption. Blue is Codex, orange is Claude. History begins with the first observed reading.`}
                >
                  {[20, 35, 50].map((y) => (
                    <line key={y} x1="5" x2="275" y1={y} y2={y} stroke="var(--border)" />
                  ))}
                  <path
                    d="M5 65 L275 5"
                    fill="none"
                    stroke="var(--foreground)"
                    strokeWidth="1.5"
                    strokeDasharray="6 4"
                    opacity="0.7"
                  />
                  {row.series.map((series, index) => {
                    if (!series) return null;
                    const samples = history[series.key] ?? [];
                    const last = samples[samples.length - 1];
                    const x = 5 + 270 * (elapsedShare(series.window, now) ?? 0);
                    return (
                      <g key={series.key} stroke={COLORS[index]}>
                        <line x1={x} x2={x} y1="5" y2="65" strokeDasharray="2 3" opacity="0.4" />
                        <path
                          d={quotaPath(samples, series.window)}
                          fill="none"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        {last ? (
                          <circle
                            cx={5 + 270 * (elapsedShare(series.window, last.at) ?? 0)}
                            cy={65 - last.used * 0.6}
                            r="3"
                            fill={COLORS[index]}
                          />
                        ) : null}
                      </g>
                    );
                  })}
                </svg>
              </div>
            ))}
            {contextWindow ? (
              <div className="flex items-baseline justify-between px-1 pt-1 text-2xs text-muted-foreground tabular-nums">
                <span>Context</span>
                <span className="text-foreground">{formatContextUsage(contextWindow)}</span>
              </div>
            ) : null}
            {promptCache ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <div className="flex items-baseline justify-between px-1 text-2xs text-muted-foreground tabular-nums" />
                  }
                >
                  <span>Prompt cache</span>
                  <span className="text-foreground">{formatPromptCache(promptCache, now)}</span>
                </TooltipTrigger>
                <TooltipPopup>
                  Estimated from the last request and the{" "}
                  {promptCache.ttlSeconds >= 3600
                    ? "1h"
                    : `${Math.round(promptCache.ttlSeconds / 60)}m`}{" "}
                  cache lifetime; the provider can evict it sooner.
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );

  // Desktop browser guests live outside the routed app. Match that document
  // layer so a standalone browser cannot cover the global quota widget.
  return canvas ? widget : createPortal(widget, document.body);
}
