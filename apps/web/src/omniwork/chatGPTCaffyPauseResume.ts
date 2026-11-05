/**
 * Scheduling a working guest is an intentional pause, not just a timer edit.
 * Confirm its genuine Stop generation click BEFORE persisting the Caffy
 * deadline. A failed stop cannot leave a misleading "paused until" schedule.
 */
export async function scheduleCaffyBegin(
  beginAt: number | null,
  working: boolean,
  stopGeneration: () => Promise<void>,
  saveSchedule: (beginAt: number | null) => Promise<unknown>,
  options?: {
    /** Suspend existing Caffy idle wakes while the stop action is in flight. */
    suspendWake?: () => Promise<unknown>;
    /** Restore the original monitor if Stop or deadline persistence fails. */
    resumeWake?: () => Promise<unknown>;
  },
): Promise<boolean> {
  const interrupted = working && beginAt !== null;
  if (!interrupted) {
    await saveSchedule(beginAt);
    return false;
  }
  let suspended = false;
  let saved = false;
  if (options?.suspendWake) {
    await options.suspendWake();
    suspended = true;
  }
  try {
    await stopGeneration();
    // Saving a future deadline also unpauses the monitor durably in the
    // desktop scheduler. No second IPC (which may fail) is needed here.
    await saveSchedule(beginAt);
    saved = true;
  } catch (error) {
    // If stop/scheduling failed, restore the original monitor state.
    // Once the future schedule is saved, NEVER issue an early wake.
    if (suspended && !saved && options?.resumeWake)
      await options.resumeWake().catch(() => {});
    throw error;
  }
  return true;
}
