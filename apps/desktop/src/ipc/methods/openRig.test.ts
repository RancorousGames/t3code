import { describe, expect, it, vi } from "vite-plus/test";

import {
  bindOpenRigSeat,
  decodeOpenRigAgents,
  decodeOpenRigSessions,
  fetchOpenRigAgents,
  fetchOpenRigSessions,
  sendOpenRigMessage,
  unbindOpenRigSeat,
} from "./openRig.ts";

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
        sessionId: null,
        sessionTitle: null,
      },
    ]);
    expect(decodeOpenRigAgents([{ id: "x", name: "Idle", status: "idle" }])).toEqual([
      {
        id: "x",
        name: "Idle",
        status: "idle",
        role: null,
        task: null,
        sessionId: null,
        sessionTitle: null,
      },
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

  it("lists existing T3 sessions and links/unlinks them to OpenRig seats", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        sessions: [
          { id: "browser-1", title: "Wartribes", project: "Wartribes", status: "done_or_idle" },
        ],
      }),
    ) as typeof fetch;
    expect(decodeOpenRigSessions({ sessions: [] })).toEqual([]);
    expect(await fetchOpenRigSessions(fetcher)).toEqual([
      { id: "browser-1", title: "Wartribes", project: "Wartribes", status: "done_or_idle" },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/sessions",
      expect.objectContaining({ method: "GET" }),
    );
    await bindOpenRigSeat({ id: "seat/1", sessionId: "browser-1" }, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents/seat%2F1/bind",
      expect.objectContaining({ method: "POST", body: '{"sessionId":"browser-1"}' }),
    );
    await unbindOpenRigSeat("seat/1", fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:7433/api/integrations/t3/agents/seat%2F1/bind",
      expect.objectContaining({ method: "DELETE" }),
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
