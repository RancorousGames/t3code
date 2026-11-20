import { runSwarm } from "./index.mjs";

/** The authenticated T3 MCP caller is the only author source. The model
 * cannot supply an alias or forge another thread's identity. */
export async function swarmForNativeThread(input, context) {
  if (!["read", "post"].includes(input.action)) {
    throw new Error("Native Swarm access supports read and post only");
  }
  if (typeof context.threadId !== "string" || !context.threadId.trim()) {
    throw new Error("Authenticated native thread identity required");
  }
  const membership = await runSwarm(
    {
      action: "read",
      swarmId: input.swarmId,
      limit: 1,
      includeWakes: false,
    },
    { root: context.root },
  );
  const matching = membership.members.filter(
    (member) =>
      member.kind === "native" &&
      member.threadId === context.threadId &&
      (!member.environmentId || member.environmentId === context.environmentId),
  );
  if (matching.length !== 1) {
    throw new Error("Calling native thread must have exactly one Swarm membership");
  }
  const actor = matching[0].alias;
  if (input.action === "read") {
    const data = await runSwarm(
      {
        action: "read",
        swarmId: input.swarmId,
        ...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
        limit: input.limit ?? 20,
        includeWakes: false,
      },
      { root: context.root },
    );
    return { actor, data };
  }
  if (typeof input.messageId !== "string") {
    throw new Error("Native Swarm posts require a caller-stable messageId UUID");
  }
  const data = await runSwarm(
    {
      action: "post",
      swarmId: input.swarmId,
      author: actor,
      messageId: input.messageId,
      body: input.body,
      ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
    },
    { root: context.root, enabled: true, transports: context.transports },
  );
  return { actor, data };
}
