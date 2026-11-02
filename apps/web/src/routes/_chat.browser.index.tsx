import { createFileRoute } from "@tanstack/react-router";

import { usePrimaryEnvironmentId } from "../state/environments";
import { ChatGPTSessionsDashboard } from "../components/ChatGPTSessionsDashboard";
import { ChatGPTRegistryRemoteDashboard } from "../components/ChatGPTRegistryRemoteDashboard";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";

function BrowserIndex() {
  const environmentId = usePrimaryEnvironmentId();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <span className="text-sm font-medium">ChatGPT · Sessions dashboard</span>
      </WorkspacePageHeader>
      {environmentId
        ? isElectron
          ? <ChatGPTSessionsDashboard environmentId={environmentId} />
          : <ChatGPTRegistryRemoteDashboard environmentId={environmentId} />
        : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Connect an environment to view ChatGPT sessions.
          </div>}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/browser/")({ component: BrowserIndex });
