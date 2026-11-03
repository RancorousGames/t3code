import assert from "node:assert/strict";
import { test } from "node:test";
import { findToolResultMarkerSessions } from "./chatgpt-react-marker.mjs";

const marker = "T3_SELF_0123456789ABCDEF0123456789ABCDEF";
test("tool-only marker resolves an exact mounted session", async () => {
  const seen = [];
  const sessions = [{ id: "A" }, { id: "B" }, { id: "C" }];
  const exchange = async (_address, request) => {
    seen.push(request);
    return {
      ok: true,
      requestId: request.requestId,
      data: {
        sessionId: request.sessionId,
        status: "inspected",
        markerFound: request.sessionId === "B",
      },
    };
  };
  assert.deepEqual(
    await findToolResultMarkerSessions(sessions, marker, { home: ".t3", exchange }),
    ["B"],
  );
  assert.ok(seen.every((x) => x.action === "marker_probe" && x.marker === marker));
});
test("unavailable guests are ignored without guessing a sender", async () => {
  const exchange = async () => {
    throw new Error("unmounted");
  };
  assert.deepEqual(
    await findToolResultMarkerSessions([{ id: "A" }], marker, { home: ".t3", exchange }),
    [],
  );
});
