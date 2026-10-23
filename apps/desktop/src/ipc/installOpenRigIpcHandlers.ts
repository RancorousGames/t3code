import * as Effect from "effect/Effect";
import * as DesktopIpc from "./DesktopIpc.ts";
import * as OpenRigIpc from "./methods/openRig.ts";

// Keep the OpenRig lifecycle, approvals and human inbox wiring in one additive seam.
export const installOpenRigIpcHandlers = Effect.fn("desktop.ipc.installOpenRigHandlers")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    yield* ipc.handle(OpenRigIpc.listOpenRigAgents);
    yield* ipc.handle(OpenRigIpc.listPendingOpenRigNativeApprovals);
    yield* ipc.handle(OpenRigIpc.getOpenRigNativeApproval);
    yield* ipc.handle(OpenRigIpc.requestOpenRigNativeReview);
    yield* ipc.handle(OpenRigIpc.readOpenRigOperatorInbox);
    yield* ipc.handle(OpenRigIpc.speakOpenRigPreview);
    yield* ipc.handle(OpenRigIpc.submitOpenRigHumanResponse);
    yield* ipc.handle(OpenRigIpc.sendOpenRigOperatorReply);
    yield* ipc.handle(OpenRigIpc.reconcileOpenRigOperatorReply);
    yield* ipc.handle(OpenRigIpc.listOpenRigSessions);
    yield* ipc.handle(OpenRigIpc.listOpenRigManagedSessions);
    yield* ipc.handle(OpenRigIpc.discoverOpenRigSeats);
    yield* ipc.handle(OpenRigIpc.readOpenRigSeatReports);
    yield* ipc.handle(OpenRigIpc.readOpenRigAgentTasks);
    yield* ipc.handle(OpenRigIpc.readOpenRigPolicyForBrowserSendIpc);
    yield* ipc.handle(OpenRigIpc.readOpenRigExecutionProfile);
    yield* ipc.handle(OpenRigIpc.configureOpenRigExecutionProfile);
    yield* ipc.handle(OpenRigIpc.startOpenRigManagedSession);
    yield* ipc.handle(OpenRigIpc.selectOpenRigPrimarySession);
    yield* ipc.handle(OpenRigIpc.adoptOpenRigManagedSession);
    yield* ipc.handle(OpenRigIpc.reconcileOpenRigChatGPTManagedSession);
    yield* ipc.handle(OpenRigIpc.detachOpenRigManagedSession);
    yield* ipc.handle(OpenRigIpc.runOpenRigManagedBrowserLifecycle);
    yield* ipc.handle(OpenRigIpc.bindOpenRigAgent);
    yield* ipc.handle(OpenRigIpc.unbindOpenRigAgent);
    yield* ipc.handle(OpenRigIpc.sendOpenRigAgentMessage);
  },
);
