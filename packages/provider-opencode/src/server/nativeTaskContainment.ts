import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

// Fork-only containment policy. The upstream adapter still owns its ordinary
// runtime permission mapping; this layer only prevents native task execution.
const NATIVE_TASK_DENY = { permission: "task", pattern: "*", action: "deny" } as const;

export function containNativeTasks(rules: PermissionRuleset): PermissionRuleset {
  // Pin both ends because native evaluators can differ in match precedence.
  return [
    NATIVE_TASK_DENY,
    ...rules.filter((rule) => rule.permission !== "task"),
    NATIVE_TASK_DENY,
  ];
}

function matchesPermissionEcho(actual: unknown, expected: PermissionRuleset): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (rule, index) =>
        typeof rule === "object" &&
        rule !== null &&
        rule.permission === expected[index]!.permission &&
        rule.pattern === expected[index]!.pattern &&
        rule.action === expected[index]!.action,
    )
  );
}

/** Reject unacknowledged native session policies before prompt admission. */
export const requireNativeTaskHoldAck = (
  data: unknown,
  sessionId: string,
  rules: PermissionRuleset,
  kind: "root" | "child",
) =>
  Effect.gen(function* () {
    if (data === null || data === undefined) {
      return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "session.update",
        detail:
          kind === "child"
            ? "OpenCode child did not acknowledge mandatory task-deny permissions."
            : "OpenCode did not acknowledge the mandatory task-deny policy.",
      });
    }
    const updated = data as { readonly id?: unknown; readonly permission?: unknown };
    if (updated.id !== sessionId || !matchesPermissionEcho(updated.permission, rules)) {
      return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "session.update",
        detail:
          kind === "child"
            ? "OpenCode child did not acknowledge mandatory task-deny permissions."
            : "OpenCode did not acknowledge the exact mandatory native task-deny policy.",
      });
    }
  });

/** Only native-advertised slash commands need containment; normal text stays text. */
export function nativeSlashCommandName(text: string | undefined): string | undefined {
  return text?.match(/^\/([^\s/]+)(?:\s+[\s\S]*)?$/)?.[1];
}

/**
 * Inventory is negative-only: even a benign entry can change its expansion
 * after classification, so no advertised slash command is dispatched natively.
 */
export const requireUnadvertisedSlashCommand = (name: string, inventory: unknown) =>
  Effect.gen(function* () {
    if (!Array.isArray(inventory)) {
      return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "command.list",
        detail: "OpenCode native slash command inventory is unavailable; prompt held.",
      });
    }
    const names = new Set<string>();
    for (const entry of inventory) {
      const current = entry?.name;
      if (
        typeof current !== "string" ||
        current.length === 0 ||
        current.trim() !== current ||
        names.has(current)
      ) {
        return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
          operation: "command.list",
          detail: "OpenCode native slash command inventory is ambiguous; prompt held.",
        });
      }
      names.add(current);
    }
    if (names.has(name)) {
      return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "session.command",
        detail:
          "OpenCode advertised native slash command dispatch is unsupported while native subtask expansion cannot be ruled out.",
      });
    }
  });
