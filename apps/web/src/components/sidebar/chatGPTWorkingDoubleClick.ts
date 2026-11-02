/**
 * A double click crosses two activity observations. Preserve the first click's
 * intent so a working -> idle transition cannot unexpectedly snooze a session,
 * and an idle -> working transition cannot snooze a new generation.
 */
export function workingDoubleClickAction(
  firstClickWorking: boolean | null,
  workingNow: boolean,
): "hide-working" | "snooze" | "ignore" {
  if (firstClickWorking === true) return workingNow ? "hide-working" : "ignore";
  if (firstClickWorking === false) return workingNow ? "ignore" : "snooze";
  return workingNow ? "hide-working" : "snooze";
}
