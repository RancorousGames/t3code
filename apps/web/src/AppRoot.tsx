import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { ProviderResetSound } from "./components/ProviderResetSound";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { ChatGPTBrowserPrewarm } from "./components/sidebar/ChatGPTBrowserPrewarm";
import { ChatGPTSessionRegistryDriver } from "./components/sidebar/ChatGPTSessionRegistryDriver";
import { ChatGPTRecoveryExperimentObserver } from "./components/sidebar/ChatGPTRecoveryExperimentObserver";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      <ChatGPTBrowserPrewarm />
      <ChatGPTSessionRegistryDriver />
      <ChatGPTRecoveryExperimentObserver />
      <ProviderResetSound />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
