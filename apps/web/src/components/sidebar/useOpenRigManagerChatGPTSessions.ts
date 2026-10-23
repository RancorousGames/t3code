import type { DesktopOpenRigSeatSessions } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { isOpenRigManagerRole, verifiedManagerChatGPTTabIds } from "./chatGPTSidebarVisuals";

const REFRESH_MS = 90_000;

/**
 * Read-only attribution. Only a currently active OpenRig managed session,
 * attached to an actual RigSpec manager seat, can decorate a browser row.
 * Titles, parent IDs, local hints and legacy bindings never establish this.
 */
export function useOpenRigManagerChatGPTSessions(
  environmentId: string | null,
): ReadonlySet<string> | null {
  // null means the authoritative seat roles have NOT been verified, not
  // "there are no managers". Keep unknown nested sessions visible.
  const [evidence, setEvidence] = useState<{
    environmentId: string;
    ids: ReadonlySet<string> | null;
  } | null>(null);
  useEffect(() => {
    if (!isElectron || !environmentId) return;
    let disposed = false;
    let requesting = false;
    const refresh = async () => {
      if (requesting || disposed) return;
      const discover = window.desktopBridge?.discoverOpenRigSeats;
      const read = window.desktopBridge?.listOpenRigManagedSessions;
      if (!discover || !read) {
        setEvidence({ environmentId, ids: null });
        return;
      }
      requesting = true;
      try {
        const topology = await discover();
        if (topology.source !== "openrig-rigspec") throw new Error("Unverified seat topology");
        const managerSeats = topology.seats.filter((seat) => isOpenRigManagerRole(seat.role));
        const responses = await Promise.allSettled(managerSeats.map((seat) => read(seat.id)));
        if (
          responses.some(
            (result, index) =>
              result.status !== "fulfilled" || result.value.seatId !== managerSeats[index]?.id,
          )
        )
          throw new Error("Incomplete authoritative manager seat ledgers");
        const ledgers: DesktopOpenRigSeatSessions[] = responses.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        if (!disposed)
          setEvidence({
            environmentId,
            ids: verifiedManagerChatGPTTabIds(topology, ledgers, environmentId),
          });
      } catch {
        // Offline or absent OpenRig evidence is not permission to label by title.
        if (!disposed) setEvidence({ environmentId, ids: null });
      } finally {
        requesting = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [environmentId]);
  return evidence?.environmentId === environmentId ? evidence.ids : null;
}
