import { describe, expect, it } from "vite-plus/test";
import { chatGPTCloseStatus } from "./chatGPTCloseStatus";

const id = "e94b2d0f-99cd-4bad-a7d8-c23c72d206de";
const audit = [
  {
    version: 1,
    sessionId: id,
    removedAt: "2026-10-26T02:20:00Z",
    source: "desktop-IPC-request",
    persistence: "local-session-list-verified",
    conversationId: "6adeb35c-2c48-83ed-a173-fdaf93cb9f14",
  },
];

describe("read-only closed browser status", () => {
  it("requires a persisted exact-ID IPC removal receipt before confirming closed", () => {
    expect(chatGPTCloseStatus(id, [], audit)).toMatchObject({
      status: "closed",
      persisted: true,
      conversationId: audit[0]!.conversationId,
    });
    expect(chatGPTCloseStatus(id, [{ id }], audit).status).toBe("open");
    expect(chatGPTCloseStatus(id, [], []).status).toBe("unknown");
    expect(chatGPTCloseStatus(id, [], [{ ...audit[0], sessionId: "other" }]).status).toBe(
      "unknown",
    );
    expect(chatGPTCloseStatus(id, [], [{ ...audit[0], source: "expiration" }]).status).toBe(
      "unknown",
    );
    expect(chatGPTCloseStatus(id, [], [{ ...audit[0], persistence: "unverified" }]).status).toBe(
      "unknown",
    );
  });
});
