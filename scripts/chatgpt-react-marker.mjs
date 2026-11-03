import { randomUUID } from "node:crypto";
import { controlAddress } from "./spawn-chatgpt-session.mjs";

// Read-only, exact-token check in mounted ChatGPT guests. Never focus a tab.
export async function findToolResultMarkerSessions(sessions, marker, { home, exchange }) {
  const found = [];
  for (let index = 0; index < sessions.length; index += 4) {
    const group = await Promise.all(
      sessions.slice(index, index + 4).map(async (session) => {
        const requestId = randomUUID();
        try {
          const response = await exchange(
            controlAddress(home),
            {
              version: 1,
              requestId,
              type: "chatgpt.sessions",
              action: "marker_probe",
              sessionId: session.id,
              marker,
            },
            15000,
          );
          if (
            response?.ok &&
            response.requestId === requestId &&
            response.data?.sessionId === session.id &&
            response.data?.status === "inspected" &&
            response.data?.markerFound === true
          )
            return session.id;
        } catch {
          /* Unmounted guest or old renderer: caller falls back. */
        }
        return null;
      }),
    );
    found.push(...group.filter(Boolean));
  }
  return found;
}
