import type {
  DesktopOmniHubKeepAwakeReadResult,
  DesktopOmniHubKeepAwakeTargetSession,
  DesktopOmniHubKeepAwakeControlQuery,
  DesktopOmniHubKeepAwakeControlReceipt,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  chatGPTBrowserLastUrlKey,
  readChatGPTBrowserSessions,
} from "../chatGPTBrowserSessions";
import { getLocalStorageItem } from "../hooks/useLocalStorage";

/** Exact persisted browser metadata, including hidden/unloaded guests; never mounts guests. */
export function readOmniHubKeepAwakeBrowserTargets(
  environmentId: EnvironmentId,
): DesktopOmniHubKeepAwakeTargetSession[] {
  return readChatGPTBrowserSessions(environmentId).map((session) => {
    let url: string | null = null;
    try {
      url =
        getLocalStorageItem(
          chatGPTBrowserLastUrlKey(environmentId, session.id),
          Schema.String,
        ) ?? session.archive?.conversationUrl ?? null;
    } catch {
      // An unreadable URL is unknown, not a reason to load the guest.
    }
    return {
      id: session.id,
      kind: "t3/chatgpt_browser",
      title: session.title,
      hidden: session.hidden === true,
      url,
    };
  });
}

/** Exact monitor-ID control through trusted desktop main and the real scheduler. */
export async function controlOmniHubKeepAwakeForT3(
  input: DesktopOmniHubKeepAwakeControlQuery,
): Promise<DesktopOmniHubKeepAwakeControlReceipt | null> {
  const method = window.desktopBridge?.controlOmniHubKeepAwakeMonitor;
  return method ? method(input) : null;
}

/**
 * Desktop-only one-shot read for the future Claude-owned window and refresh.
 * Native session evidence is optional: without it, native targets stay unchecked,
 * not falsely "missing". No monitor or session is mutated by this call.
 */
export async function readOmniHubKeepAwakeForT3(
  environmentId: EnvironmentId,
  nativeSessions?: readonly DesktopOmniHubKeepAwakeTargetSession[],
): Promise<DesktopOmniHubKeepAwakeReadResult | null> {
  const bridge = window.desktopBridge;
  if (!bridge?.readOmniHubKeepAwakeMonitors) return null;
  const sessions = [
    ...readOmniHubKeepAwakeBrowserTargets(environmentId),
    ...(nativeSessions ?? []),
  ];
  return bridge.readOmniHubKeepAwakeMonitors({
    sessions,
    checkedKinds: nativeSessions === undefined
      ? ["t3/chatgpt_browser"]
      : ["t3/chatgpt_browser", "t3/native_thread"],
  });
}
