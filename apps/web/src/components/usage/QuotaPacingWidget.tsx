import { useAtomValue } from "@effect/atom-react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import { collectLimitAccounts, elapsedShare, paceOf } from "@t3tools/shared/usageLimits";
import { GaugeIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import * as Schema from "effect/Schema";

import { isElectron } from "../../env";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePrimaryEnvironmentId } from "../../state/environments";
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
import {
  ACTIVE_HISTORY_WINDOW_MS,
  ACTIVE_SAMPLE_GAP_MS,
  ACTIVE_SAMPLE_INTERVAL_MS,
  type ActiveSample,
  activeSampleRuns,
  useChatGPTActiveHistory,
} from "./chatGPTActiveHistory";

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

const ACTIVE_COLOR = "#84cc16";
const PLOT = { left: 18, right: 274, top: 6, bottom: 48 };
const HOUR_MS = 60 * 60_000;

/** Step chart of sampled working ChatGPT sessions; unobserved spans are hatched, never filled in. */
function ChatGPTActiveSessions({
  samples,
  now,
}: {
  samples: readonly ActiveSample[];
  now: number;
}) {
  const patternId = `chatgpt-gap-${useId().replace(/[^\w-]/g, "")}`;
  const latest = samples[samples.length - 1];
  const end = Math.max(now, latest?.at ?? 0);
  const start = end - ACTIVE_HISTORY_WINDOW_MS;
  const chart = useMemo(() => {
    const inWindow = samples.filter((sample) => sample.at >= start);
    const peak = inWindow.reduce((max, sample) => Math.max(max, sample.working), 0);
    const yMax = Math.max(2, peak);
    const x = (at: number) =>
      PLOT.left +
      ((PLOT.right - PLOT.left) * (Math.min(end, Math.max(start, at)) - start)) /
        ACTIVE_HISTORY_WINDOW_MS;
    const y = (value: number) => PLOT.bottom - ((PLOT.bottom - PLOT.top) * value) / yMax;
    const lines: string[] = [];
    const areas: string[] = [];
    const gaps: Array<readonly [number, number]> = [];
    let cursor = start;
    for (const run of activeSampleRuns(inWindow)) {
      const first = run[0]!;
      if (first.at - cursor > 1_000) gaps.push([x(cursor), x(first.at)]);
      // Each sample holds until the next one, or for one sampling interval at the end of a run.
      const runEnd = Math.min(end, run[run.length - 1]!.at + ACTIVE_SAMPLE_INTERVAL_MS);
      let line = `M${x(first.at).toFixed(1)} ${y(first.working).toFixed(1)}`;
      for (const sample of run.slice(1)) {
        line += ` H${x(sample.at).toFixed(1)} V${y(sample.working).toFixed(1)}`;
      }
      line += ` H${x(runEnd).toFixed(1)}`;
      lines.push(line);
      areas.push(`${line} V${PLOT.bottom} H${x(first.at).toFixed(1)} Z`);
      cursor = runEnd;
    }
    if (end - cursor > 1_000) gaps.push([x(cursor), x(end)]);
    const ticks = [5, 4, 3, 2, 1, 0].map((hours) => ({
      x: x(end - hours * HOUR_MS),
      label: hours === 0 ? "now" : `-${hours}h`,
    }));
    return { peak, yMax, x, y, lines, areas, gaps, ticks, observed: inWindow.length > 0 };
  }, [samples, start, end]);
  const fresh = latest !== undefined && end - latest.at <= ACTIVE_SAMPLE_GAP_MS;
  const middle = chart.yMax % 2 === 0 ? chart.yMax / 2 : null;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between px-1">
        <span className="text-xs font-semibold">ChatGPT active</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                className="text-xl leading-none font-bold tracking-tight tabular-nums"
                style={{ color: fresh ? ACTIVE_COLOR : undefined }}
                aria-label={
                  fresh
                    ? `${latest.working} ChatGPT sessions working now`
                    : "Current ChatGPT activity unknown"
                }
              />
            }
          >
            {fresh ? latest.working : "—"}
          </TooltipTrigger>
          <TooltipPopup>
            {fresh
              ? `${latest.working} of ${latest.tracked} tracked ChatGPT sessions working · sampled ${new Date(latest.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
              : "No recent sample; current ChatGPT activity is unknown"}
          </TooltipPopup>
        </Tooltip>
      </div>
      <div className="mb-1 flex justify-between px-1 text-2xs tabular-nums text-muted-foreground">
        <span>Last 5h{chart.observed ? ` · peak ${chart.peak}` : ""}</span>
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-xs" style={{ background: ACTIVE_COLOR }} />
            working
          </span>
          <span className="flex items-center gap-1">
            <svg aria-hidden viewBox="0 0 8 8" className="size-2 rounded-xs">
              <rect width="8" height="8" fill={`url(#${patternId})`} />
            </svg>
            no data
          </span>
        </span>
      </div>
      <svg
        viewBox="0 0 280 60"
        className="h-[60px] w-full rounded-md border border-white bg-background/80"
        role="img"
        aria-label={`Working ChatGPT sessions over the last five hours, sampled once a minute${chart.observed ? `; peak ${chart.peak}` : ""}. Hatched spans had no observation.`}
      >
        <defs>
          <pattern
            id={patternId}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" x2="0" y1="0" y2="4" stroke="var(--muted-foreground)" opacity="0.45" />
          </pattern>
        </defs>
        {[chart.yMax, middle].map((value) =>
          value === null ? null : (
            <g key={value}>
              <line
                x1={PLOT.left}
                x2={PLOT.right}
                y1={chart.y(value)}
                y2={chart.y(value)}
                stroke="var(--border)"
              />
              <text
                x={PLOT.left - 4}
                y={chart.y(value) + 2.5}
                textAnchor="end"
                fontSize="7"
                fill="var(--muted-foreground)"
              >
                {value}
              </text>
            </g>
          ),
        )}
        {chart.gaps.map(([from, to]) => (
          <rect
            key={`${from}:${to}`}
            x={from}
            width={Math.max(0, to - from)}
            y={PLOT.top}
            height={PLOT.bottom - PLOT.top}
            fill={`url(#${patternId})`}
          />
        ))}
        <line
          x1={PLOT.left}
          x2={PLOT.right}
          y1={PLOT.bottom}
          y2={PLOT.bottom}
          stroke="var(--muted-foreground)"
          opacity="0.6"
        />
        <text
          x={PLOT.left - 4}
          y={PLOT.bottom + 2.5}
          textAnchor="end"
          fontSize="7"
          fill="var(--muted-foreground)"
        >
          0
        </text>
        {chart.areas.map((area) => (
          <path key={area} d={area} fill={ACTIVE_COLOR} opacity="0.18" />
        ))}
        {chart.lines.map((line) => (
          <path
            key={line}
            d={line}
            fill="none"
            stroke={ACTIVE_COLOR}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        ))}
        {fresh ? (
          <circle
            cx={chart.x(latest.at + ACTIVE_SAMPLE_INTERVAL_MS)}
            cy={chart.y(latest.working)}
            r="2.5"
            fill={ACTIVE_COLOR}
          />
        ) : null}
        {chart.ticks.map((tick, index) => (
          <g key={tick.label}>
            <line
              x1={tick.x}
              x2={tick.x}
              y1={PLOT.bottom}
              y2={PLOT.bottom + 2}
              stroke="var(--muted-foreground)"
              opacity="0.6"
            />
            <text
              x={tick.x}
              y={PLOT.bottom + 9}
              textAnchor={index === 0 ? "start" : index === 5 ? "end" : "middle"}
              fontSize="7"
              fill="var(--muted-foreground)"
            >
              {tick.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeSamples = useChatGPTActiveHistory(primaryEnvironmentId, isElectron);
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
            {isElectron && primaryEnvironmentId ? (
              <ChatGPTActiveSessions samples={activeSamples} now={now} />
            ) : null}
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
