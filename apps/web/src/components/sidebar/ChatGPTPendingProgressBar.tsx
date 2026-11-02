import { useEffect, useRef } from "react";
import type { PendingSessionProgress } from "./chatGPTPendingSessionProgress";

/** Advance smoothly but backtrack promptly after missed ETA or queue reprioritization. */
export function ChatGPTPendingProgressBar({ progress, kind }: Pick<PendingSessionProgress, "progress" | "kind">) {
  const previous = useRef(progress);
  const delayed = progress < previous.current - 0.005;
  useEffect(() => { previous.current = progress; }, [progress]);
  return (
    <span aria-hidden="true"
      className={`pointer-events-none absolute inset-y-0 left-0 rounded-md ${kind === "recovery" ? "bg-orange-400/15" : "bg-sky-400/15"}`}
      style={{ width: `${Math.round(progress * 100)}%`,
        transition: delayed ? "width 130ms ease-out" : "width 5s linear" }}
    />
  );
}
