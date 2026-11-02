import * as Effect from "effect/Effect";

import { receiveProviderAuthCallback, cancelProviderAuthCallback } from "./methods/providerAuth.ts";
import * as DesktopIpc from "./DesktopIpc.ts";
import { installNotificationBadge } from "./methods/notificationBadge.ts";
import { getClientSettings, setClientSettings } from "./methods/clientSettings.ts";
import { getConnectionCatalog, setConnectionCatalog } from "./methods/connectionCatalog.ts";
import {
  getLocalEnvironmentEnabled,
  setLocalEnvironmentEnabled,
} from "./methods/localEnvironment.ts";
import {
  getAdvertisedEndpoints,
  getServerExposureState,
  setServerExposureMode,
  setTailscaleServeEnabled,
} from "./methods/serverExposure.ts";
import {
  bootstrapSshBearerSession,
  disconnectSshEnvironment,
  discoverSshHosts,
  ensureSshEnvironment,
  fetchSshEnvironmentDescriptor,
  fetchSshSessionState,
  resolveSshHost,
  resolveSshPasswordPrompt,
} from "./methods/sshEnvironment.ts";
import {
  checkForUpdate,
  downloadUpdate,
  getUpdateState,
  installUpdate,
  setUpdateChannel,
} from "./methods/updates.ts";
import {
  getAppBranding,
  getLocalEnvironmentBootstraps,
  getLocalEnvironmentBearerToken,
  installRelayTelemetryEnabled,
  getSystemLocale,
  getWindowFullscreenState,
  openExternal,
  readMedia,
  openSystemSettings,
  checkSystemPermission,
  pasteAsText,
  probeRemoteEditors,
  revealWindow,
  pickFolder,
  pickProjectFavicon,
  pickThemeFiles,
  setTheme,
  showContextMenu,
} from "./methods/window.ts";
import {
  acknowledgeSnapShot,
  checkSnapShotShortcut,
  dismissSnapShotAnimation,
  getSnapShotState,
  setupSnapShot,
  previewSnapShotConfig,
  applySnapShotConfig,
  listPendingSnapShots,
  readSnapShot,
  requestSnapShotPermissions,
  setSnapShotAnimationDestination,
  setSnapShotShortcutSuppressed,
} from "./methods/snapShot.ts";
import * as PreviewIpc from "./methods/preview.ts";
import { installOpenRigIpcHandlers } from "./installOpenRigIpcHandlers.ts";
import { savePrivateChatGPTDraftSnapshotIpc } from "./methods/chatGPTDraftSnapshot.ts";
import { persistentChatGPTRequestIpc } from "./methods/persistentChatGPTBrowser.ts";
import { stableChatGPTViewRequestIpc } from "./methods/stableChatGPTView.ts";
import { readChatGPTBootstrapTitleIpc } from "./methods/chatGPTBootstrapTitle.ts";
import { readTaskBoardWorkerClaimsIpc } from "./methods/taskBoardWorkerClaims.ts";
import {
  openTaskBoardLiveSessionIpc,
  controlTaskBoardLiveSessionIpc,
} from "./methods/taskBoardLiveSession.ts";
import {
  openTaskBoardLinkIpc,
  openFirefoxLinkIpc,
  openWartribesTourIpc,
} from "./methods/taskBoardSmartLinks.ts";
import { searchChatGPTHistoryIpc } from "./methods/chatGPTHistorySearch.ts";
import {
  readTaskBoardHumanInboxIpc,
  openTaskBoardHumanItemIpc,
} from "./methods/taskBoardHumanInboxIpc.ts";
import {
  controlOmniHubKeepAwakeMonitorIpc,
  readOmniHubKeepAwakeMonitorsIpc,
  startOmniHubKeepAwakeMonitorIpc,
} from "./methods/omniHubKeepAwake.ts";
import { readCaffyManagedIdleIpc, cancelCaffyManagedIdleIpc } from "./methods/caffyManagedIdle.ts";
import { chatGPTCapacityMessageIpc } from "./methods/chatGPTCapacityMessage.ts";
import * as AppActivationIpc from "./methods/appActivation.ts";
import * as WebLinksIpc from "./methods/webLinks.ts";
import {
  completeLegacyLocalStorage,
  takeLegacyLocalStorage,
} from "./methods/legacyLocalStorage.ts";
import { getWslState, setWslBackendEnabled, setWslDistro, setWslOnly } from "./methods/wsl.ts";
import {
  getCliCommandState,
  installCliCommand,
  uninstallCliCommand,
} from "./methods/cliCommand.ts";

export const installDesktopIpcHandlers = Effect.fn("desktop.ipc.installHandlers")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* installNotificationBadge();
  yield* PreviewIpc.installPreviewEventForwarding();

  yield* ipc.handle(AppActivationIpc.setReady);
  yield* ipc.handle(AppActivationIpc.complete);
  yield* ipc.handle(AppActivationIpc.enqueueChatGPT);
  yield* ipc.handle(AppActivationIpc.recordIdle);
  yield* ipc.handle(AppActivationIpc.recipientMounted);
  yield* ipc.handle(AppActivationIpc.deliveryDiagnostics);
  yield* ipc.handle(WebLinksIpc.setReady);

  yield* ipc.handleSync(takeLegacyLocalStorage);
  yield* ipc.handle(completeLegacyLocalStorage);
  yield* ipc.handleSync(getAppBranding);
  yield* installRelayTelemetryEnabled();
  yield* ipc.handleSync(getSystemLocale);
  yield* ipc.handleSync(getWindowFullscreenState);
  yield* ipc.handleSync(getLocalEnvironmentBootstraps);
  yield* ipc.handleSync(getLocalEnvironmentEnabled);
  yield* ipc.handle(setLocalEnvironmentEnabled);
  yield* ipc.handle(getLocalEnvironmentBearerToken);

  yield* ipc.handle(getClientSettings);
  yield* ipc.handle(setClientSettings);
  yield* ipc.handle(savePrivateChatGPTDraftSnapshotIpc);
  yield* ipc.handle(readChatGPTBootstrapTitleIpc);
  yield* ipc.handle(persistentChatGPTRequestIpc);
  yield* ipc.handle(stableChatGPTViewRequestIpc);
  yield* ipc.handle(readTaskBoardWorkerClaimsIpc);
  yield* ipc.handle(openTaskBoardLiveSessionIpc);
  yield* ipc.handle(openTaskBoardLinkIpc);
  yield* ipc.handle(openFirefoxLinkIpc);
  yield* ipc.handle(openWartribesTourIpc);
  yield* ipc.handle(searchChatGPTHistoryIpc);
  yield* ipc.handle(controlTaskBoardLiveSessionIpc);
  yield* ipc.handle(readTaskBoardHumanInboxIpc);
  yield* ipc.handle(openTaskBoardHumanItemIpc);
  yield* ipc.handle(chatGPTCapacityMessageIpc);
  yield* ipc.handle(readCaffyManagedIdleIpc);
  yield* ipc.handle(cancelCaffyManagedIdleIpc);
  yield* ipc.handle(readOmniHubKeepAwakeMonitorsIpc);
  yield* ipc.handle(controlOmniHubKeepAwakeMonitorIpc);
  yield* ipc.handle(startOmniHubKeepAwakeMonitorIpc);
  yield* installOpenRigIpcHandlers();
  yield* ipc.handle(getConnectionCatalog);
  yield* ipc.handle(getSnapShotState);
  yield* ipc.handle(setupSnapShot);
  yield* ipc.handle(previewSnapShotConfig);
  yield* ipc.handle(applySnapShotConfig);
  yield* ipc.handle(requestSnapShotPermissions);
  yield* ipc.handle(checkSnapShotShortcut);
  yield* ipc.handle(setSnapShotShortcutSuppressed);
  yield* ipc.handle(listPendingSnapShots);
  yield* ipc.handle(readSnapShot);
  yield* ipc.handle(setSnapShotAnimationDestination);
  yield* ipc.handle(dismissSnapShotAnimation);
  yield* ipc.handle(acknowledgeSnapShot);
  yield* ipc.handle(setConnectionCatalog);

  yield* ipc.handle(discoverSshHosts);
  yield* ipc.handle(resolveSshHost);
  yield* ipc.handle(ensureSshEnvironment);
  yield* ipc.handle(disconnectSshEnvironment);
  yield* ipc.handle(fetchSshEnvironmentDescriptor);
  yield* ipc.handle(bootstrapSshBearerSession);
  yield* ipc.handle(fetchSshSessionState);
  yield* ipc.handle(resolveSshPasswordPrompt);

  yield* ipc.handle(getServerExposureState);
  yield* ipc.handle(setServerExposureMode);
  yield* ipc.handle(setTailscaleServeEnabled);
  yield* ipc.handle(getAdvertisedEndpoints);

  yield* ipc.handle(getWslState);
  yield* ipc.handle(setWslBackendEnabled);
  yield* ipc.handle(setWslDistro);
  yield* ipc.handle(setWslOnly);

  yield* ipc.handle(pickFolder);
  yield* ipc.handle(pickProjectFavicon);
  yield* ipc.handle(pickThemeFiles);
  yield* ipc.handle(setTheme);
  yield* ipc.handle(showContextMenu);
  yield* ipc.handle(openExternal);
  yield* ipc.handle(readMedia);
  yield* ipc.handle(receiveProviderAuthCallback);
  yield* ipc.handle(cancelProviderAuthCallback);
  yield* ipc.handle(openSystemSettings);
  yield* ipc.handle(checkSystemPermission);
  yield* ipc.handle(pasteAsText);
  yield* ipc.handle(revealWindow);
  yield* ipc.handle(probeRemoteEditors);
  yield* ipc.handle(getUpdateState);
  yield* ipc.handle(setUpdateChannel);
  yield* ipc.handle(downloadUpdate);
  yield* ipc.handle(installUpdate);
  yield* ipc.handle(checkForUpdate);
  yield* ipc.handle(getCliCommandState);
  yield* ipc.handle(installCliCommand);
  yield* ipc.handle(uninstallCliCommand);
  for (const previewMethod of PreviewIpc.methods) {
    // Explicit types preserve the error/service union of these heterogeneous preview methods.
    yield* ipc.handle<
      Effect.Error<ReturnType<(typeof PreviewIpc.methods)[number]["handler"]>>,
      Effect.Services<ReturnType<(typeof PreviewIpc.methods)[number]["handler"]>>
    >(previewMethod);
  }
  yield* ipc.handle(PreviewIpc.listBrowserImportSources);
  yield* ipc.handle(PreviewIpc.importBrowserCookies);
});
