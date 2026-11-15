/** FIFO of nonterminal TaskBoard execution attempts. Membership is rebuilt from
 * TaskBoard snapshots; T3 never stores a second authoritative queue. */
export interface ActiveWork {
  boardRoot: string;
  taskId: string;
  queueRequest: string;
  reservationId?: string | null;
  state: string;
  stateSince?: string | null;
  created?: string;
  legacyOpenRig?: boolean;
}

export interface ActiveWorkEntry {
  key: string;
  boardRoot: string;
  taskId: string;
  queueRequest: string;
  reservationId: string | null;
  firstObservedAt: number;
}

export function activeWorkKey(item: ActiveWork): string {
  return [item.boardRoot.toLowerCase(), item.taskId, item.queueRequest, item.reservationId ?? ""].join("\0");
}

function isTracked(item: ActiveWork): boolean {
  return !item.legacyOpenRig &&
    (item.state === "reserved" || item.state === "starting" || item.state === "working" ||
      (item.state === "queued" && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.queueRequest)));
}

export class ActiveWorkFifo {
  private entries: ActiveWorkEntry[] = [];

  /** Existing positions survive polling; new attempts join the tail, stale attempts leave. */
  sync(items: readonly ActiveWork[], now: number): void {
    const eligible = new Map(items.filter(isTracked).map(item => [activeWorkKey(item), item]));
    this.entries = this.entries.filter(entry => eligible.has(entry.key));
    const known = new Set(this.entries.map(entry => entry.key));
    const discovered: Array<{entry: ActiveWorkEntry; order: number}> = [];
    for (const [key, item] of eligible) {
      if (known.has(key)) continue;
      const timestamp = Date.parse(item.stateSince ?? "");
      const firstObservedAt = Number.isFinite(timestamp) && timestamp <= now ? timestamp : now;
      discovered.push({
        entry: {
          key, boardRoot: item.boardRoot, taskId: item.taskId,
          queueRequest: item.queueRequest, reservationId: item.reservationId ?? null,
          firstObservedAt,
        },
        order: firstObservedAt,
      });
    }
    discovered.sort((a, b) => a.order - b.order);
    this.entries.push(...discovered.map(row => row.entry));
  }

  /** Inspect up to count distinct entries, rotating each to the back. */
  take(count: number): ActiveWorkEntry[] {
    const n = Math.min(this.entries.length, Math.max(0, Math.floor(count)));
    const chosen = this.entries.splice(0, n);
    this.entries.push(...chosen);
    return chosen;
  }

  get size(): number { return this.entries.length; }
}
