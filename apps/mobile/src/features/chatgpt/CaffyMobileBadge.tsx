import {
  caffyBadge,
  caffyNextWake,
  caffyRecentEvents,
  caffyStoppedBadge,
  readCaffyRecord,
  type CaffyColor,
  type CaffyReadout,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";

const colors: Record<CaffyColor, { pill: string; text: string; rail: string; glyph: string }> = {
  green: {
    pill: "border-emerald-400/70 bg-emerald-500/20",
    text: "text-emerald-300",
    rail: "border-emerald-400/60",
    glyph: "#72e9a4",
  },
  purple: {
    pill: "border-violet-400/70 bg-violet-500/20",
    text: "text-violet-300",
    rail: "border-violet-400/60",
    glyph: "#c19aff",
  },
  cyan: {
    pill: "border-cyan-300/70 bg-cyan-500/20",
    text: "text-cyan-200",
    rail: "border-cyan-300/60",
    glyph: "#83dbed",
  },
  blue: {
    pill: "border-blue-400/70 bg-blue-500/20",
    text: "text-blue-300",
    rail: "border-blue-400/60",
    glyph: "#638fff",
  },
  orange: {
    pill: "border-orange-400/70 bg-orange-500/20",
    text: "text-orange-300",
    rail: "border-orange-400/60",
    glyph: "#ff9e5f",
  },
  red: {
    pill: "border-rose-400/70 bg-rose-500/20",
    text: "text-rose-300",
    rail: "border-rose-400/60",
    glyph: "#ff687f",
  },
};

export function caffyMobileRecord(record: Record<string, unknown>): {
  monitor: CaffyReadout | null;
  stoppedAt: number | null;
} {
  const monitor = readCaffyRecord(record.caffyStatus);
  const stoppedAt =
    !monitor && typeof record.caffyStoppedAt === "number" && Number.isFinite(record.caffyStoppedAt)
      ? record.caffyStoppedAt
      : null;
  return { monitor, stoppedAt };
}

/** The AI screen is browserless; these badges use desktop-projected scheduler evidence. */
export function CaffyMobileBadge({
  monitor,
  stoppedAt,
  now,
  expanded,
  stale,
  onPress,
  onLongPress,
}: {
  monitor: CaffyReadout | null;
  stoppedAt: number | null;
  now: number;
  expanded: boolean;
  stale: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const badge = monitor ? caffyBadge(monitor, now) : stoppedAt ? caffyStoppedBadge() : null;
  if (!badge) return null;
  const color = colors[badge.color];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        badge.label + (stale ? " (last-known)." : ".") + " Tap for details, long press for actions."
      }
      accessibilityState={{ expanded }}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
      onLongPress={(event) => {
        event.stopPropagation();
        onLongPress();
      }}
      className={`ml-1 min-h-7 shrink-0 flex-row items-center gap-1 rounded-md border px-2 py-1 ${color.pill}`}
    >
      <Svg
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color.glyph}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Path d="M4 8h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z" />
        <Path d="M16 9h1.4a3 3 0 0 1 0 6H16" />
        <Path d="M2.8 20h16.8M8 5c-.8-1 .7-1.5.1-2.4M12 5c-.8-1 .7-1.5.1-2.4" />
      </Svg>
      <Text className={`text-xs font-bold ${color.text}`}>{badge.code}</Text>
    </Pressable>
  );
}

export function CaffyMobileDetails({
  monitor,
  stoppedAt,
  now,
  stale,
}: {
  monitor: CaffyReadout | null;
  stoppedAt: number | null;
  now: number;
  stale: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const badge = monitor ? caffyBadge(monitor, now) : stoppedAt ? caffyStoppedBadge() : null;
  if (!badge) return null;
  const color = colors[badge.color];
  const timeline = monitor
    ? caffyRecentEvents(monitor)
    : stoppedAt
      ? [{ time: stoppedAt, label: "Agent stopped Caffy" }]
      : [];
  return (
    <View className={`mt-3 rounded-lg border-l-2 bg-screen p-3 ${color.rail}`}>
      <Text className={`text-sm font-semibold ${color.text}`}>
        {badge.label}
        {stale ? " · Last-known" : ""}
      </Text>
      <Text className="mt-1 text-xs leading-5 text-foreground">{badge.sentence}</Text>
      <View className="mt-2 flex-row gap-2">
        <View className="min-w-0 flex-1 rounded-lg bg-subtle p-2">
          <Text className="text-[10px] text-foreground-muted">Next wake</Text>
          <Text className="mt-1 text-xs text-foreground">
            {monitor ? caffyNextWake(monitor, now) : "None"}
          </Text>
        </View>
        <View className="min-w-0 flex-1 rounded-lg bg-subtle p-2">
          <Text className="text-[10px] text-foreground-muted">Previous wake</Text>
          <Text className="mt-1 text-xs text-foreground">
            {monitor?.lastWakeAt ? new Date(monitor.lastWakeAt).toLocaleString() : "Never"}
          </Text>
        </View>
      </View>
      <Text className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
        Recent events
      </Text>
      {timeline.length === 0 ? (
        <Text className="mt-1 text-xs text-foreground-muted">No scheduler events recorded.</Text>
      ) : (
        timeline.map((event) => (
          <View
            key={event.time + event.label}
            className="flex-row border-b border-border/60 py-1.5"
          >
            <Text className="w-16 text-[10px] text-foreground-muted">
              {new Date(event.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </Text>
            <Text className="min-w-0 flex-1 text-xs text-foreground">{event.label}</Text>
          </View>
        ))
      )}
      {monitor ? (
        <>
          <Pressable
            accessibilityRole="button"
            className="mt-2 py-2"
            onPress={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
          >
            <Text className="text-xs text-foreground-muted">
              {expanded ? "▾" : "▸"} Scheduler details
            </Text>
          </Pressable>
          {expanded && (
            <View className="gap-1">
              <Text className="text-xs text-foreground">
                Working slots: {monitor.respectSlots ? "Respected" : "Unrestricted"}
              </Text>
              <Text className="text-xs text-foreground">
                Auto-reboot:{" "}
                {monitor.autoRebootEveryRuns
                  ? `Every ${monitor.autoRebootEveryRuns} runs`
                  : monitor.autoRebootMinutes
                    ? `Every ${monitor.autoRebootMinutes}m`
                    : "Off"}
              </Text>
              <Text className="text-xs text-foreground">
                Last check:{" "}
                {monitor.lastCheckedAt ? new Date(monitor.lastCheckedAt).toLocaleString() : "Never"}
              </Text>
              {monitor.lastError && (
                <Text className="text-xs text-rose-300">Last error: {monitor.lastError}</Text>
              )}
            </View>
          )}
        </>
      ) : null}
    </View>
  );
}
