import { readChatGPTSessionProfileId } from "../chatGPTAccountProfiles";

type NativeBridge = NonNullable<NonNullable<Window["desktopBridge"]>["stableChatGPTViewRequest"]>;

export type NativeChatGPTResidency = "resident" | "missing" | "unknown";
export interface NativeChatGPTPageStatus {
  residency: NativeChatGPTResidency;
  loading: boolean | null;
  loadError: string | null;
}

const identityFor = (environmentId: string, sessionId: string) => ({
  environmentId,
  sessionId,
  profileId: readChatGPTSessionProfileId(environmentId, sessionId),
});

/** A native Chrome page is owned by Electron, not by a mounted React webview.
 * Unknown IPC errors are NOT evidence that its page should be opened again. */
export async function nativeChatGPTPageStatus(
  bridge: NativeBridge,
  environmentId: string,
  sessionId: string,
): Promise<NativeChatGPTPageStatus> {
  try {
    const status = (await bridge({
      operation: "probe",
      identity: identityFor(environmentId, sessionId),
    })) as {
      residency?: "resident" | "missing" | "mismatch";
      destroyed?: boolean;
      url?: string;
      loading?: boolean;
      loadError?: string | null;
    };
    // An identity/profile mismatch must never authorize another attach. Only
    // the native owner can positively identify a missing page.
    return {
      residency: status.residency === "missing" ? "missing" :
        status.residency === "resident" && status.destroyed === false &&
          typeof status.url === "string" && status.url.length > 0
          ? "resident" : "unknown",
      loading: status.loading ?? null,
      loadError: status.loadError ?? null,
    };
  } catch {
    // Transport/old-main failures are UNKNOWN, not evidence of absence.
    return { residency: "unknown", loading: null, loadError: null };
  }
}

export async function nativeChatGPTResidency(
  bridge: NativeBridge,
  environmentId: string,
  sessionId: string,
): Promise<NativeChatGPTResidency> {
  return (await nativeChatGPTPageStatus(bridge, environmentId, sessionId)).residency;
}

/** Only create a demonstrably missing page. Native attach is idempotent if a
 * foreground mount raced our snapshot: it does NOT navigate or reload. */
export async function warmMissingNativeChatGPT(
  bridge: NativeBridge,
  environmentId: string,
  sessionId: string,
  url: string,
): Promise<boolean> {
  if ((await nativeChatGPTResidency(bridge, environmentId, sessionId)) !== "missing") return false;
  await bridge({ operation: "attach", identity: identityFor(environmentId, sessionId), url });
  return true;
}
