import { type EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { PreviewView } from "../components/preview/PreviewView";
import { ChatGPTBrowserFindBar } from "../components/browser/ChatGPTBrowserFindBar";
import { ChatGPTDuplicateConversationBanner } from "../components/browser/ChatGPTDuplicateConversationBanner";
import {
  CHATGPT_DEFAULT_URL,
  chatGPTBrowserThreadRef,
  useChatGPTBrowserSessions,
} from "../chatGPTBrowserSessions";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { usePrimaryEnvironmentId } from "../state/environments";

function ChatGPTBrowserRoute() {
  const environmentId = usePrimaryEnvironmentId();
  const { browserSessionId } = Route.useParams();
  const { sessions } = useChatGPTBrowserSessions(environmentId);
  const session = sessions.find((entry) => entry.id === browserSessionId);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <span className="text-sm font-medium">{session?.title ?? "ChatGPT"}</span>
      </WorkspacePageHeader>
      {!isElectron ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          The integrated browser is available in the desktop app.
        </div>
      ) : environmentId && session && !session.hidden ? (
        <ChatGPTBrowserView
          key={`${environmentId}:${session.id}`}
          environmentId={environmentId}
          sessionId={session.id}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {environmentId
            ? session?.hidden
              ? "This browser session is hidden. Restore it from Hidden sessions."
              : "This browser session has been closed."
            : "Connect an environment to open the browser."}
        </div>
      )}
    </SidebarInset>
  );
}

function ChatGPTBrowserView({
  environmentId,
  sessionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
}) {
  const threadRef = useMemo(
    () => chatGPTBrowserThreadRef(environmentId, sessionId),
    [environmentId, sessionId],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ChatGPTDuplicateConversationBanner environmentId={environmentId} sessionId={sessionId} />
      <PreviewView
        threadRef={threadRef}
        visible
        standalone
        configuredUrls={[CHATGPT_DEFAULT_URL]}
      />
      <ChatGPTBrowserFindBar threadRef={threadRef} />
    </div>
  );
}

export const Route = createFileRoute("/_chat/browser/$browserSessionId")({
  component: ChatGPTBrowserRoute,
});
