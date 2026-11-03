import { randomBytes } from "node:crypto";

// The browser, not the agent, owns the T3 session identity.
export const newSelfMarker = () => `T3_SELF_${randomBytes(16).toString("hex").toUpperCase()}`;

export function findSelfMarkerSessions(sessions, marker) {
  if (!/^T3_SELF_[A-F0-9]{32}$/.test(marker)) throw new Error("Invalid self marker.");
  return (sessions ?? [])
    .filter((s) => {
      if (s.hidden === true) return false;
      const latest = s.lastRole === "assistant" ? [s.lastText, s.latestMessageFirstFiveWords] : [];
      const history = Array.isArray(s.messages)
        ? s.messages.filter((m) => m.role === "assistant").map((m) => m.text)
        : [];
      return [...latest, ...history].some(
        (text) => typeof text === "string" && text.includes(marker),
      );
    })
    .map((s) => s.id);
}
