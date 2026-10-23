import type { DesktopOpenRigSeatSessions, DesktopOpenRigSeatTopology } from "@t3tools/contracts";
import type { BrowserSession } from "../../chatGPTBrowserSessions";

/** Only the explicit RigSpec role (never a display title) establishes manager type. */
export function isOpenRigManagerRole(role: string | null): boolean {
  return /^(?:manager|[a-z]+(?:[-_][a-z]+)*[-_]manager)$/u.test((role ?? "").toLowerCase());
}

/** A session title (including "Manager") and a legacy browser binding establish no seat identity. */
export function verifiedManagerChatGPTTabIds(
  topology: DesktopOpenRigSeatTopology,
  ledgers: readonly DesktopOpenRigSeatSessions[],
  environmentId: string,
): ReadonlySet<string> {
  const managerSeatIds = new Set(
    topology.source === "openrig-rigspec"
      ? topology.seats.filter((seat) => isOpenRigManagerRole(seat.role)).map((seat) => seat.id)
      : [],
  );
  const ids = new Set<string>();
  for (const ledger of ledgers) {
    if (!managerSeatIds.has(ledger.seatId)) continue;
    for (const session of ledger.sessions) {
      if (
        session.seatId !== ledger.seatId ||
        session.status !== "active" ||
        (session.mode !== "chatgpt" && session.mode !== "adopt") ||
        session.target?.kind !== "chatgpt-conversation" ||
        (session.environmentId !== null && session.environmentId !== environmentId) ||
        !session.attachedTabUuid
      )
        continue;
      ids.add(session.attachedTabUuid);
    }
  }
  return ids;
}

/** Use one stable project label for every child/row even in status-only groups. */
export function chatGPTSidebarProjectTitles(
  sessions: readonly BrowserSession[],
  groupedByProject: readonly {
    readonly title: string | null;
    readonly key: string | null;
    readonly rows: readonly { readonly session: BrowserSession }[];
  }[],
): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const session of sessions) {
    if (session.project?.trim()) titles.set(session.id, session.project.trim());
  }
  // Displayed grouping takes precedence: a child follows its actual parent's
  // project even if its stored project hint predates the verified parent link.
  for (const group of groupedByProject) {
    if (group.key === "other" || group.key?.startsWith("status:") || !group.title) continue;
    for (const { session } of group.rows) titles.set(session.id, group.title);
  }
  return titles;
}
