import type { DesktopAppActivationRequest, DesktopAppActivationResponse } from "@t3tools/contracts";
import { runOpenRigHumanInboxControl } from "../../openRigHumanInboxControl";

// The IPC dispatch stays independent of native thread and provider-v1 paths.
export async function handleOpenRigHumanInboxActivation(
  request: Extract<DesktopAppActivationRequest, { type: "openrig.human_inbox" }>,
): Promise<DesktopAppActivationResponse> {
  try {
    const data = await runOpenRigHumanInboxControl({
      action: request.action,
      address: request.address,
      limit: request.limit,
      itemId: request.itemId,
      sourceType: request.sourceType,
      state: request.state,
      answers: request.answers,
    });
    return { version: 1, requestId: request.requestId, ok: true, data };
  } catch (error) {
    return {
      version: 1,
      requestId: request.requestId,
      ok: false,
      code: "internal-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
