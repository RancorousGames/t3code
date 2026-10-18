import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DesktopAppActivationRequest } from "./desktopAppActivation.js";

const valid = Schema.is(DesktopAppActivationRequest);
const common = { version: 1, requestId: "local-id" } as const;

describe("ChatGPT local desktop bridge protocol", () => {
  it("accepts source/recipient T3 IDs on sends without requiring a sender", () => {
    expect(
      valid({
        ...common,
        type: "chatgpt.sessions",
        action: "send",
        sessionId: "recipient",
        senderSessionId: "caller-reported-source",
        message: "Update",
      }),
    ).toBe(true);
    expect(
      valid({
        ...common,
        type: "chatgpt.sessions",
        action: "send",
        sessionId: "recipient",
        message: "Legacy",
      }),
    ).toBe(true);
  });

  it("only accepts a canonical ChatGPT conversation UUID as optional routing precondition", () => {
    const id = "6ad4addb-8fc0-83eb-832c-47b147adffb2";
    for (const action of ["send", "read"] as const) {
      expect(
        valid({
          ...common,
          type: "chatgpt.sessions",
          action,
          sessionId: "target",
          expectedConversationId: id,
        }),
      ).toBe(true);
      expect(valid({ ...common, type: "chatgpt.sessions", action, sessionId: "target" })).toBe(
        true,
      );
      for (const invalidId of [
        "",
        "  ",
        "not-a-uuid",
        id.toUpperCase(),
        `https://chatgpt.com/c/${id}`,
        id + "-extra",
      ]) {
        expect(
          valid({
            ...common,
            type: "chatgpt.sessions",
            action,
            sessionId: "target",
            expectedConversationId: invalidId,
          }),
        ).toBe(false);
      }
    }
  });

  it("accepts completion declarations but not an unbounded renderer wait request", () => {
    expect(
      valid({
        ...common,
        type: "chatgpt.sessions",
        action: "complete",
        sessionId: "worker",
      }),
    ).toBe(true);
    expect(
      valid({
        ...common,
        type: "chatgpt.sessions",
        action: "wait",
        sessionIds: ["worker"],
        mode: "all",
      }),
    ).toBe(false);
  });

  it("keeps explicit spawn parent optional, without accepting a made-up caller context", () => {
    expect(
      valid({
        ...common,
        type: "chatgpt.spawn",
        title: "Child",
        prompt: "Do work.",
        parentSessionId: "parent-uuid",
        project: "t3code",
      }),
    ).toBe(true);
    expect(
      valid({
        ...common,
        type: "chatgpt.spawn",
        title: "Unparented",
        prompt: "Do work.",
      }),
    ).toBe(true);
  });
});
