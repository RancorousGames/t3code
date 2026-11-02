// @vitest-environment node
// @ts-expect-error jsdom is installed for tests but @types/jsdom is not in this workspace.
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { runChatGPTSessionControl } from "./chatGPTSessionControl";

const dom = new JSDOM("", { url: "https://t3.local/" });
vi.stubGlobal("window", dom.window);
vi.stubGlobal("localStorage", dom.window.localStorage);
afterEach(() => dom.window.localStorage.clear());

it("reads environment recovery aggregates before any guest enumeration or hydration", async () => {
  const forbiddenSessions = new Proxy([], {
    get() {
      throw new Error("GUEST TOUCHED");
    },
  });
  const result = await runChatGPTSessionControl({
    environmentId: "privacy-test" as never,
    action: "recovery_metrics",
    sessions: forbiddenSessions,
  });
  expect(result).toMatchObject({
    action: "recovery_metrics",
    metrics: { availability: "missing", observationCoverage: "untracked", successRate: null },
  });
});

it("refuses guest/session-bearing telemetry reads before guest lookup", async () => {
  const sessions = new Proxy([], {
    get() {
      throw new Error("GUEST TOUCHED");
    },
  });
  await expect(
    runChatGPTSessionControl({
      environmentId: "privacy-test" as never,
      action: "recovery_metrics",
      sessions,
      sessionId: "forbidden",
    }),
  ).rejects.toThrow(/does not accept guest/);
  await expect(
    runChatGPTSessionControl({
      environmentId: "privacy-test" as never,
      action: "recovery_metrics",
      sessions,
      message: "draft or transcript",
    }),
  ).rejects.toThrow(/does not accept guest/);
});
