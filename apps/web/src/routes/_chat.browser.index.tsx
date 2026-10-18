import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useChatGPTBrowserSessions } from "../chatGPTBrowserSessions";
import { usePrimaryEnvironmentId } from "../state/environments";

function BrowserIndex() {
  const environmentId = usePrimaryEnvironmentId();
  const { sessions, createSession } = useChatGPTBrowserSessions(environmentId);
  const navigate = useNavigate();
  const opening = useRef(false);

  useEffect(() => {
    if (!environmentId || opening.current) return;
    opening.current = true;
    void navigate({
      to: "/browser/$browserSessionId",
      params: {
        browserSessionId: sessions.find((session) => !session.hidden)?.id ?? createSession(),
      },
      replace: true,
    });
  }, [createSession, environmentId, navigate, sessions]);

  return null;
}

export const Route = createFileRoute("/_chat/browser/")({ component: BrowserIndex });
