"use client";

import { AuthPreviewOperateScope } from "@t3tools/contracts";
import { type ComponentProps, useEffect, useState } from "react";

import { useChatGPTDeliveryMountRequests } from "../chatGPTDeliveryMountRequest";

import { useClientSettingsHydrated } from "~/hooks/useSettings";
import { useEnvironmentScope } from "~/state/session";

import { useBrowserDefaults } from "./browserDefaults";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import {
  chatGPTGuestHydrationLimiter,
  shouldStaggerChatGPTGuest,
} from "./chatGPTGuestHydrationLimiter";
import {
  isChatGPTGuestWoken,
  selectChatGPTGuestHibernated,
  useChatGPTGuestHibernation,
  wakeChatGPTGuest,
} from "./chatGPTGuestHibernation";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { useChatGPTSessionSnoozed } from "./useChatGPTSessionSnoozed";

// Keep desktop guest attachment/retention separate from the upstream host's
// preview-session rendering. Selection or a targeted delivery request can
// attach a hibernated guest; ordinary background hosts remain unloaded.
export function AuthorizedBrowserWebview(props: ComponentProps<typeof HostedBrowserWebview>) {
  const canOperatePreview = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthPreviewOperateScope,
  );
  const profileId = useTabProfileId(props.profileId);
  const snoozed = useChatGPTSessionSnoozed(props.threadRef);
  const prefix = "t3-browser-session:";
  const sessionId = props.threadRef.threadId.startsWith(prefix)
    ? props.threadRef.threadId.slice(prefix.length)
    : null;
  const deliveryRequired = useChatGPTDeliveryMountRequests(
    (state) =>
      sessionId !== null &&
      state.required[`${props.threadRef.environmentId}:${sessionId}`] === true,
  );
  const selected = useBrowserSurfaceStore(
    (state) => state.byTabId[props.runtimeTabId]?.visible === true,
  );
  const hibernated = useChatGPTGuestHibernation((state) =>
    selectChatGPTGuestHibernated(state, props.runtimeTabId),
  );
  const woken = useChatGPTGuestHibernation((state) =>
    isChatGPTGuestWoken(state, props.runtimeTabId),
  );
  const stagger = shouldStaggerChatGPTGuest(props.threadRef.threadId, props.initialUrl) && !woken;
  const [guestMayAttach, setGuestMayAttach] = useState(!stagger);

  useEffect(() => {
    if (hibernated && selected && !snoozed) wakeChatGPTGuest(props.runtimeTabId);
  }, [hibernated, selected, snoozed, props.runtimeTabId]);

  useEffect(() => {
    if (!stagger || !canOperatePreview || hibernated || snoozed) return;
    const controller = new AbortController();
    void chatGPTGuestHydrationLimiter
      .request(props.runtimeTabId, controller.signal)
      .then((allowed) => {
        if (allowed && !controller.signal.aborted) setGuestMayAttach(true);
      });
    return () => controller.abort();
  }, [stagger, canOperatePreview, hibernated, snoozed, props.runtimeTabId]);

  useEffect(() => {
    if (stagger && selected) chatGPTGuestHydrationLimiter.prioritize(props.runtimeTabId);
  }, [stagger, selected, props.runtimeTabId]);

  return canOperatePreview &&
    (deliveryRequired || ((guestMayAttach || !stagger) && !hibernated && !snoozed)) ? (
    <HostedBrowserWebview {...props} profileId={profileId} />
  ) : null;
}

/**
 * Agent `preview_open` normally carries the profile clients reported (see
 * BrowserProfileReporter). An agent tab opened before any client reported has
 * none, so it falls back to the configured default here. It is latched once
 * settings load: Electron fixes the partition when the guest attaches, so a
 * later settings change must not move a live tab.
 */
function useTabProfileId(profileId: string | undefined): string | undefined {
  const hydrated = useClientSettingsHydrated();
  const defaultProfileId = useBrowserDefaults().profileId;
  const [fallback, setFallback] = useState<string | undefined>(undefined);
  if (profileId === undefined && hydrated && fallback === undefined) {
    setFallback(defaultProfileId);
  }
  return profileId ?? fallback;
}
