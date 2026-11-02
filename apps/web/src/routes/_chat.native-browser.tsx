"use client";

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";

import { StableEmbeddedChatGPTSurface } from "../browser/StableEmbeddedChatGPTSurface";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";

/** A separate, sandboxed native Chromium test browser inside T3's own window. */
const identity = {
  sessionId: "36bafe20-7ce4-4c4d-a155-0943a99f99b3",
  environmentId: "t3-native-browser-slice",
  profileId: "isolated-web",
};
const initialUrl = "https://www.wikipedia.org/";

function NativeBrowserPage() {
  const [address, setAddress] = useState(initialUrl);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState({ back: false, forward: false });
  const bridge = window.desktopBridge?.stableChatGPTViewRequest;

  const refreshLocation = useCallback(async () => {
    if (!bridge) return;
    try {
      const snapshot = (await bridge({ operation: "snapshot", identity })) as {
        url?: string;
        canGoBack?: boolean;
        canGoForward?: boolean;
      };
      if (typeof snapshot.url === "string" && snapshot.url !== "") {
        setCurrentUrl(snapshot.url);
        setAddress(snapshot.url);
      }
      setHistory({
        back: snapshot.canGoBack === true,
        forward: snapshot.canGoForward === true,
      });
    } catch {
      // The view is not attached yet; its component will report failures.
    }
  }, [bridge]);

  const navigate = async (typed: string) => {
    try {
      const url = new URL(
        /^https?:\/\//i.test(typed.trim()) ? typed.trim() : `https://${typed.trim()}`,
      );
      if (url.protocol !== "https:") throw new Error("Only HTTPS sites are supported.");
      if (!bridge) throw new Error("The embedded browser is unavailable in this T3 build.");
      setError(null);
      await bridge({ operation: "navigate", identity, url: url.href });
      await refreshLocation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const command = async (operation: "back" | "forward" | "reload") => {
    if (!bridge) return;
    try {
      setError(null);
      await bridge({ operation, identity });
      await refreshLocation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <span className="text-sm font-medium">Native Browser</span>
        <span className="text-xs text-muted-foreground">Chromium embedded in T3</span>
      </WorkspacePageHeader>
      {isElectron ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-2">
            <button
              type="button"
              aria-label="Browser back"
              title="Back"
              disabled={!history.back}
              onClick={() => void command("back")}
              className="rounded p-1.5 hover:bg-muted disabled:opacity-30"
            >
              <ArrowLeft size={17} />
            </button>
            <button
              type="button"
              aria-label="Browser forward"
              title="Forward"
              disabled={!history.forward}
              onClick={() => void command("forward")}
              className="rounded p-1.5 hover:bg-muted disabled:opacity-30"
            >
              <ArrowRight size={17} />
            </button>
            <button
              type="button"
              aria-label="Reload browser"
              title="Reload"
              onClick={() => void command("reload")}
              className="rounded p-1.5 hover:bg-muted"
            >
              <RotateCw size={16} />
            </button>
            <form
              className="min-w-0 flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                void navigate(address);
              }}
            >
              <input
                aria-label="Native browser address"
                className="h-8 w-full rounded-md border border-border bg-muted/30 px-3 text-sm"
                spellCheck={false}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
              />
            </form>
            <button
              type="button"
              onClick={() => void navigate(address)}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
            >
              Go
            </button>
          </div>
          {error ? (
            <div role="alert" className="border-b px-3 py-1.5 text-xs">
              {error}
            </div>
          ) : null}
          <div className="relative min-h-0 flex-1">
            <StableEmbeddedChatGPTSurface
              {...identity}
              initialUrl={initialUrl}
              onUrlChange={(url) => {
                if (url !== currentUrl) {
                  setCurrentUrl(url);
                  setAddress(url);
                  void refreshLocation();
                }
              }}
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          The native browser is available in the T3 desktop app.
        </div>
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/native-browser")({
  component: NativeBrowserPage,
});
