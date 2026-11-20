import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as DesktopTransport from "../chatgpt-delegation/DesktopTransport.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerConfig.ServerConfig,
  Path.Path,
  DesktopTransport.DesktopTransport,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
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

const PlanSwarmTeam = Tool.make("swarm_plan_team", {
  ...common,
  description:
    "As the attached native coordinator, persist a distinct mixed native/ChatGPT team plan " +
    "for an explicitly authorized Swarm goal. Planning alone launches no workers. " +
    "Use stable assignmentId UUIDs and then call swarm_dispatch_team.",
  parameters: Schema.Struct({
    swarmId: Schema.String,
    goalId: Schema.String,
    assignments: Schema.Array(
      Schema.Struct({
        assignmentId: Schema.String,
        member: Schema.String,
        kind: Schema.Literals(["native", "chatgpt"]),
        title: Schema.String,
        task: Schema.String,
        providerInstanceId: Schema.optional(Schema.String),
      }),
    ),
  }),
  success: Schema.Unknown,
})
  .annotate(Tool.Title, "Plan Swarm team")
  .annotate(Tool.Idempotent, true);

const DispatchSwarmTeam = Tool.make("swarm_dispatch_team", {
  ...common,
  description:
    "Delegate planned Swarm workers through T3's existing authorized delegate_task implementation, " +
    "or send assignments to already attached members. Enforces the persisted per-goal cap, " +
    "preserves stable request IDs and never retries uncertain launches. Explicit opt-in goal required.",
  parameters: Schema.Struct({ swarmId: Schema.String, goalId: Schema.String }),
  success: Schema.Unknown,
})
  .annotate(Tool.Title, "Dispatch Swarm team")
  .annotate(Tool.OpenWorld, true);

const SyncSwarmTeam = Tool.make("swarm_sync_team", {
  ...common,
  description:
    "Explicitly reconcile newly delegated ChatGPT session identity and attach it to the shared board. " +
    "Does not launch workers, poll, verify or finish assignments.",
  parameters: Schema.Struct({ swarmId: Schema.String, goalId: Schema.String }),
  success: Schema.Unknown,
})
  .annotate(Tool.Title, "Bind Swarm workers")
  .annotate(Tool.Idempotent, true);

export const SwarmToolkit = Toolkit.make(
  ReadSwarmBoard,
  PostSwarmMessage,
  PlanSwarmTeam,
  DispatchSwarmTeam,
  SyncSwarmTeam,
);
