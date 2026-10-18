import { useEffect, useRef } from "react";
import { useEnvironments } from "../state/environments";
import { playNotificationSound, unlockNotificationAudio } from "../threadNotifications";

/** Notify only for reset deadlines observed while this renderer is running. */
export function ProviderResetSound() {
  const { environments } = useEnvironments();
  const deadlines = useRef(new Map<string, number>());
  const initialized = useRef(false);
  const notified = useRef(new Set<string>());
  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = Date.now();
      for (const [key, at] of deadlines.current) {
        const id = `${key}:${at}`;
        if (at <= now && at > now - 60_000 && !notified.current.has(id)) {
          notified.current.add(id);
          void playNotificationSound("input", () => true);
        }
      }
    }, 5_000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => {
    const onGesture = () => unlockNotificationAudio();
    document.addEventListener("pointerdown", onGesture);
    document.addEventListener("keydown", onGesture);
    return () => {
      document.removeEventListener("pointerdown", onGesture);
      document.removeEventListener("keydown", onGesture);
    };
  }, []);
  useEffect(() => {
    const observed = new Map<string, number>();
    for (const environment of environments) {
      for (const provider of environment.serverConfig?.providers ?? []) {
        for (const window of provider.usageLimits?.windows ?? []) {
          if (window.windowDurationMins !== 300 && window.id !== "five_hour") continue;
          const at = Date.parse(window.resetsAt ?? "");
          if (Number.isFinite(at))
            observed.set(`${environment.environmentId}:${provider.instanceId}:${window.id}`, at);
        }
      }
    }
    if (!initialized.current) {
      const now = Date.now();
      for (const [key, at] of observed) if (at <= now) notified.current.add(`${key}:${at}`);
      initialized.current = true;
    }
    deadlines.current = observed;
  }, [environments]);
  return null;
}
