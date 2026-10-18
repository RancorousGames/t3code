import { describe, expect, it, vi } from "vite-plus/test";

import { decodeOpenRigAgents, fetchOpenRigAgents, sendOpenRigMessage } from "./openRig.ts";

describe("local OpenRig desktop proxy", () => {
  it("accepts bridge agent lists and keeps task/status metadata", () => {
    expect(
      decodeOpenRigAgents({
        agents: [
          {
            id: "opaque:42",
            name: "Implementer",
            status: "working",
            role: "worker",
            task: "T3 sidebar",
          },
        ],
      }),
    ).toEqual([
      {
        id: "opaque:42",
        name: "Implementer",
        status: "working",
        role: "worker",
        task: "T3 sidebar",
      },
    ]);
    expect(decodeOpenRigAgents([{ id: "x", name: "Idle", status: "idle" }])).toEqual([
      { id: "x", name: "Idle", status: "idle", role: null, task: null },
    ]);
    expect(() => decodeOpenRigAgents({ sessions: [] })).toThrow("Invalid OpenRig agents response");
  });

  it("fetches only the fixed loopback agents endpoint, without redirects", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        agents: [{ id: "r-1", name: "Researcher", status: "idle", task: "Review" }],
      }),
    ) as typeof fetch;
    expect(await fetchOpenRigAgents(fetcher)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents",
      expect.objectContaining({ method: "GET", redirect: "error", cache: "no-store" }),
    );
  });

  it("sends an opaque ID as one encoded segment and a message body", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
    await sendOpenRigMessage({ id: "agent/with space?#%", message: "Status please" }, fetcher);
    const [url, options] = vi.mocked(fetcher).mock.calls[0]!;
    expect(url).toBe(
      "http://127.0.0.1:7433/api/integrations/t3/agents/agent%2Fwith%20space%3F%23%25/send",
    );
    expect(options).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "Status please" }),
      }),
    );
    await expect(sendOpenRigMessage({ id: "", message: "x" }, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects upstream errors; sending is never reported successful on 500", async () => {
    const fetcher = vi.fn(async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(fetchOpenRigAgents(fetcher)).rejects.toThrow("HTTP 500");
    await expect(sendOpenRigMessage({ id: "agent", message: "hello" }, fetcher)).rejects.toThrow(
      "HTTP 500",
    );
  });
});
