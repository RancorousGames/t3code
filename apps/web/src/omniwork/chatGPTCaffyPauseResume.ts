/** Schedule the future wake even when a stale working indicator has no Stop control. */
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
  let stopped = false;
  if (options?.suspendWake) {
    await options.suspendWake();
    suspended = true;
  }
  try {
    try {
      await stopGeneration();
      stopped = true;
    } catch {
      // Stop is best-effort; a stale working state or unloaded guest must not block scheduling.
    }
    // Saving the future deadline also unpauses the monitor durably.
    await saveSchedule(beginAt);
    saved = true;
  } catch (error) {
    // A failed schedule must restore the original monitor state.
    // Once the future schedule is saved, NEVER issue an early wake.
    if (suspended && !saved && options?.resumeWake)
      await options.resumeWake().catch(() => {});
    throw error;
  }
  return stopped;
}
