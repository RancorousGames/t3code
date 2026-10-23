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

  it("recognizes local native thread list/read/send with scoped environment identity", () => {
    const threadId = "f39d2467-d783-4578-8ba9-ccac017b1871";
    const clientRequestId = "6ad41909-57c8-43ed-a20f-742a43cd06a6";
    expect(valid({ ...common, type: "t3.threads", action: "list" })).toBe(true);
    expect(valid({ ...common, type: "t3.threads", action: "providers", environmentId: "t3-env" })).toBe(true);
    expect(
      valid({
        ...common,
        type: "t3.threads",
        action: "read",
        environmentId: "t3-local",
        threadId,
        count: 4,
      }),
    ).toBe(true);
    expect(
      valid({
        ...common,
        type: "t3.threads",
        action: "send",
        environmentId: "t3-local",
        threadId,
        message: "Progress?",
        clientRequestId,
      }),
    ).toBe(true);
    expect(
      valid({
        ...common,
        type: "t3.threads",
        action: "read",
        threadId: "",
        count: 1,
      }),
    ).toBe(false);
  });

  it("accepts exact UUID and opaque MCP native read/send recipients without granting create authority", () => {
    const validId = "f39d2467-d783-4578-8ba9-ccac017b1871";
    const messageId = "6ad41909-57c8-43ed-a20f-742a43cd06a6";
    const accepted = [
      validId,
      "mcp:d92d7667-7b13-4bd8-868f-230ede021e8b",
      "thread:mcp:source:child",
      "thread:mcp:source%3Aworker%2Fchild:0",
      "thread:mcp:a%25b:0",
    ];
    for (const threadId of accepted) {
      for (const action of ["read", "send"] as const) {
        expect(valid({
          ...common, type: "t3.threads", action, environmentId: "t3-env", threadId,
          ...(action === "send" ? { message: "Proceed", clientRequestId: messageId } : { count: 2 }),
        })).toBe(true);
      }
      expect(valid({
        ...common, type: "t3.threads", action: "create", environmentId: "t3-env",
        threadId,
      })).toBe(false);
    }
    for (const threadId of [
      "", "mcp:", "mcp:non-uuid", "thread:mcp:", "thread:mcp:foo%2", "thread:mcp:foo%QQ",
      "thread:mcp:foo%FF", "thread:mcp:foo%0A", "thread:mcp:foo%20bar",
      "thread:mcp:foo/bar", "thread:mcp:foo?bar", " thread:mcp:foo",
      "thread:mcp:" + "x".repeat(241),
    ]) {
      for (const action of ["read", "send"] as const) {
        expect(valid({
          ...common, type: "t3.threads", action, threadId,
          ...(action === "send" ? { message: "Proceed", clientRequestId: messageId } : { count: 2 }),
        }), `Malformed recipient ${JSON.stringify(threadId)} was accepted for ${action}`).toBe(false);
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

  it("accepts explicit hidden-list opt-in and exact session state transitions", () => {
    expect(valid({
      ...common, type: "chatgpt.sessions", action: "list", which: "all", includeHidden: true,
    })).toBe(true);
    expect(valid({
      ...common, type: "chatgpt.sessions", action: "list", includeHidden: "yes",
    })).toBe(false);
    for (const state of ["hidden", "unhidden", "closed"] as const) {
      expect(valid({
        ...common, type: "chatgpt.sessions", action: "change_state",
        sessionId: "exact-session", state,
      })).toBe(true);
    }
    expect(valid({
      ...common, type: "chatgpt.sessions", action: "change_state",
      sessionId: "exact-session", state: "delete",
    })).toBe(false);
  });

  it("accepts archive/restore and typed explicit manager decisions", () => {
    expect(
      valid({ ...common, type: "chatgpt.sessions", action: "archive", sessionId: "worker" }),
    ).toBe(true);
    expect(
      valid({ ...common, type: "chatgpt.sessions", action: "restore", sessionId: "worker" }),
    ).toBe(true);
    expect(
      valid({
        ...common,
        type: "chatgpt.sessions",
        action: "archive",
        sessionId: "worker",
        managerDecision: true,
        reason: "Reviewed handoff",
      }),
    ).toBe(true);
    expect(
      valid({
        ...common,
        type: "chatgpt.sessions",
        action: "archive",
        sessionId: "worker",
        managerDecision: "true",
      }),
    ).toBe(false);
    expect(
      valid({
        ...common,
        type: "chatgpt.sessions",
        action: "archive",
        sessionId: "worker",
        managerDecision: true,
        reason: " ",
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


describe("managed native thread-create protocol", () => {
  const baseCreate = {
    ...common,
    type: "t3.threads",
    action: "create",
    environmentId: "t3-env",
    workspaceRoot: "D:\\SSDProjects\\Tools\\t3code",
    runtime: "codex",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    title: "Managed session",
    clientRequestId: "7a046ce0-4a77-4b4a-a78c-66d3699d5c00",
  } as const;
  it("accepts a standalone deterministic create with explicit provider and no prompt", () => {
    expect(valid(baseCreate)).toBe(true);
    expect(valid({
      ...baseCreate,
      projectId: "c5b2d999-7c69-4709-93c9-735d76b463c7",
      firstMessage: "Review the code",
      initialMessageId: "763df61c-87b0-48b4-a771-01d72a303516",
    })).toBe(true);
  });
  it("accepts explicit OpenCode root creation and exact DeepSeek catalog selection without fallback", () => {
    const opencodeRoot = {
      ...baseCreate,
      workspaceRoot: "D:\\SSDProjects\\SettlingAltraea",
      runtime: "opencode",
      providerInstanceId: "opencode",
      modelSelection: { instanceId: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
      firstMessage: "Inspect existing changes; commit only when separately authorized.",
      initialMessageId: "763df61c-87b0-48b4-a771-01d72a303516",
    };
    expect(valid(opencodeRoot)).toBe(true);
    expect(valid({ ...opencodeRoot, runtime: "cursor" })).toBe(false);
    expect(valid({ ...opencodeRoot, runtime: "chatgpt" })).toBe(false);
    expect(valid({ ...opencodeRoot, modelSelection: { instanceId: "opencode" } })).toBe(false);
    expect(valid({ ...opencodeRoot, modelSelection: undefined })).toBe(false);
    expect(valid({ ...opencodeRoot, providerInstanceId: "" })).toBe(false);
  });
  it("requires runtime, instance, model, mode, root and operation ID", () => {
    for (const key of [
      "environmentId", "workspaceRoot", "runtime", "providerInstanceId",
      "modelSelection", "runtimeMode", "title", "clientRequestId",
    ] as const) {
      const invalid = { ...baseCreate };
      delete (invalid as Record<string, unknown>)[key];
      expect(valid(invalid)).toBe(false);
    }
    for (const mutation of [
      { runtime: "chatgpt" },
      { modelSelection: { instanceId: "codex" } },
      { providerInstanceId: "bad space" },
      { clientRequestId: "ambiguous" },
      { firstMessage: "  " },
      { initialMessageId: "not-a-uuid" },
    ]) expect(valid({ ...baseCreate, ...mutation })).toBe(false);
  });
});
