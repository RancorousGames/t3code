import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DesktopAppActivationRequest } from "./desktopAppActivation.js";

const request = {
  version: 1,
  type: "chatgpt.reboot",
  phase: "begin",
  prompt: "Continue the same seat",
  requestId: "894f98c4-3c2a-4b2a-bafe-1d3034381111",
  sessionId: "594f98c4-3c2a-4b2a-bafe-1d3034381111",
  priorConversationId: "694f98c4-3c2a-4b2a-bafe-1d3034381111",
};
describe("same browser reboot contract", () => {
  it("carries exact operation, stable browser and separate old conversation identity", () => {
    expect(Schema.decodeUnknownSync(DesktopAppActivationRequest)(request)).toEqual(request);
  });
  it("accepts old chatgpt.refresh requests only for wire compatibility", () => {
    expect(
      Schema.decodeUnknownSync(DesktopAppActivationRequest)({
        ...request,
        type: "chatgpt.refresh",
      }),
    ).toMatchObject({ type: "chatgpt.refresh" });
  });

  it("supports read-only reconciliation without resupplying the bootstrap", () => {
    const { prompt: _, ...status } = request;
    expect(
      Schema.decodeUnknownSync(DesktopAppActivationRequest)({ ...status, phase: "status" }),
    ).toMatchObject({ phase: "status" });
  });
  it.each(["requestId", "sessionId", "priorConversationId"])(
    "requires an exact UUID for %s",
    (field) => {
      expect(() =>
        Schema.decodeUnknownSync(DesktopAppActivationRequest)({ ...request, [field]: "title" }),
      ).toThrow();
    },
  );
});
