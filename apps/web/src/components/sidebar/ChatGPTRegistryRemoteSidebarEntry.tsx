import { Link } from "@tanstack/react-router";
import { MessageCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { readChatGPTRegistry } from "../../state/chatGPTSessionRegistry";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

/** Remote clients have a server-backed ChatGPT entry instead of a browser
 * toggle or desktop webview controls. No session is opened merely to list it. */
export function ChatGPTRegistryRemoteSidebarEntry() {
  const environmentId = usePrimaryEnvironmentId();
  const read = useAtomCommand(readChatGPTRegistry, { reportFailure: false });
  const [status, setStatus] = useState<{ count: number; online: boolean } | null>(null);

  useEffect(() => {
    if (!environmentId) return;
    const target = environmentId;
    let disposed = false;
    const poll = async () => {
      if (document.hidden) return;
      const result = await read({ environmentId: target, input: { environmentId: target } });
      if (disposed) return;
      if (result._tag !== "Success") {
        setStatus((last) => last ? { ...last, online: false } : null);
      } else {
        setStatus({
          count: result.value.sessions.filter((session) => session.closedAt === null && session.record.hidden !== true).length,
          online: result.value.driver.online,
        });
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 15_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [environmentId, read]);

  return (
    <SidebarMenu aria-label="ChatGPT sessions">
      <SidebarMenuItem>
        <SidebarMenuButton render={<Link to="/browser" />} tooltip="ChatGPT sessions">
          <MessageCircleIcon aria-hidden />
          <span className="min-w-0 flex-1 truncate">ChatGPT sessions</span>
          {status && <span className="text-xs text-muted-foreground" title={status.online ? "Desktop online" : "Desktop offline"}>
            {status.count} {status.online ? "" : "· offline"}
          </span>}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
