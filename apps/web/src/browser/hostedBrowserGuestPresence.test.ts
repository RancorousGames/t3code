import { expect, it } from "vite-plus/test";
import { hasHostedBrowserGuest, registerHostedBrowserGuestPresence } from "./hostedBrowserGuestPresence";

it("tracks actual attachment and ignores stale detach after replacement", () => {
  const thread = { environmentId: "presence-env", threadId: "presence-thread" } as never;
  expect(hasHostedBrowserGuest(thread)).toBe(false);
  const oldDetach = registerHostedBrowserGuestPresence(thread, "tab");
  const detach = registerHostedBrowserGuestPresence(thread, "tab");
  oldDetach();
  expect(hasHostedBrowserGuest(thread)).toBe(true);
  detach();
  expect(hasHostedBrowserGuest(thread)).toBe(false);
});
