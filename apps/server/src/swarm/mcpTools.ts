import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopTransport from "../chatgpt-delegation/DesktopTransport.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerConfig.ServerConfig,
  Path.Path,
  DesktopTransport.DesktopTransport,
  ThreadManagementService.ThreadManagementService,
];

const success = Schema.Struct({ actor: Schema.String, data: Schema.Unknown });
const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
};

const ReadSwarmBoard = Tool.make("swarm_read_board", {
  ...common,
  description:
    "Read new messages from a Swarm you are attached to as this T3 thread. " +
    "Pass afterMessageId from your previous result for incremental reads.",
  parameters: Schema.Struct({
    swarmId: Schema.String,
    afterMessageId: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  }),
  success,
})
  .annotate(Tool.Title, "Read Swarm board")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const PostSwarmMessage = Tool.make("swarm_post_message", {
  ...common,
  description:
    "Post on a Swarm under your verified native T3 thread identity. " +
    "Use a stable UUID messageId (reuse on uncertainty). @alias wakes members " +
    "via the existing T3 delivery queue; optional mentions overrides parsing.",
  parameters: Schema.Struct({
    swarmId: Schema.String,
    messageId: Schema.String,
    body: Schema.String,
    mentions: Schema.optional(Schema.Array(Schema.String)),
  }),
  success,
})
  .annotate(Tool.Title, "Post Swarm board message")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SwarmToolkit = Toolkit.make(ReadSwarmBoard, PostSwarmMessage);
