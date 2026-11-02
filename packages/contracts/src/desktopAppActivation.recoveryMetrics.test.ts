import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DesktopAppActivationRequest } from "./desktopAppActivation.js";

it("accepts a content-free session-independent recovery_metrics desktop request", () => {
  const valid = Schema.is(DesktopAppActivationRequest);
  const request = {
    version: 1,
    requestId: "telemetry-only",
    type: "chatgpt.sessions",
    action: "recovery_metrics",
  };
  expect(valid(request)).toBe(true);
  expect(valid({ ...request, action: "recovery_metrics_write" })).toBe(false);
});
