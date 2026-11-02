import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindOpenRigSeat, fetchOpenRigAgents } from "./openRig.ts";

describe("T3 OpenRig automatic credential recovery", () => {
  const homes: string[] = [];
  const withTemporaryHome = (token?: string) => {
    const home = mkdtempSync(join(tmpdir(), "t3-openrig-bearer-"));
    homes.push(home);
    vi.stubEnv("USERPROFILE", home);
    if (token) {
      const directory = join(home, ".openrig");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "terminal-token"), token);
    }
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("uses a MAIN-only configured terminal bearer on agent reads", async () => {
    withTemporaryHome();
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", "terminal-test-secret");
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "fallback-test-secret");
    const fetcher = vi.fn(async () => Response.json({ agents: [
      { id: "agent-1", name: "Worker", status: "idle" },
    ] })) as typeof fetch;
    expect(await fetchOpenRigAgents(fetcher)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents",
      expect.objectContaining({
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer terminal-test-secret",
        },
      }),
    );
  });

  it("silently discovers persisted credentials without requiring any operator input", async () => {
    withTemporaryHome("persisted-secret-longer-than-24-chars");
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", "");
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "");
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      init.headers && (init.headers as Record<string, string>).Authorization ===
        "Bearer persisted-secret-longer-than-24-chars"
        ? Response.json({ agents: [] })
        : Response.json({ error: "unauthorized" }, { status: 401 })) as typeof fetch;
    expect(await fetchOpenRigAgents(fetcher)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("recovers from a stale environment bearer by retrying only an idempotent GET with persisted credentials", async () => {
    withTemporaryHome("persisted-secret-longer-than-24-chars");
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", "stale-env-token");
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization ===
        "Bearer persisted-secret-longer-than-24-chars"
        ? Response.json({ agents: [{ id: "1", name: "A" }] })
        : Response.json({ error: "unauthorized" }, { status: 401 })) as typeof fetch;
    expect(await fetchOpenRigAgents(fetcher)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetcher).mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer stale-env-token",
    });
    expect(vi.mocked(fetcher).mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer persisted-secret-longer-than-24-chars",
    });
  });

  it("does not mask a genuine 401 when no configured or persisted token exists", async () => {
    withTemporaryHome();
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", "");
    vi.stubEnv("OPENRIG_AUTH_BEARER_TOKEN", "");
    const fetcher = vi.fn(async () => Response.json(
      { error: "unauthorized" }, { status: 401 },
    )) as typeof fetch;
    await expect(fetchOpenRigAgents(fetcher)).rejects.toThrow("OpenRig bridge HTTP 401");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not replay a POST with refreshed credentials after a 401", async () => {
    withTemporaryHome("persisted-secret-longer-than-24-chars");
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", "stale-env-token");
    const fetcher = vi.fn(async () => Response.json(
      { error: "unauthorized" }, { status: 401 },
    )) as typeof fetch;
    await expect(bindOpenRigSeat({ id: "seat-1", sessionId: "browser-1" }, fetcher))
      .rejects.toThrow("OpenRig bridge HTTP 401");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents/seat-1/bind",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer stale-env-token" }),
      }),
    );
  });
});
