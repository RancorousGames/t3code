// @vitest-environment node
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  sessions: [{ id: "session", snoozedUntil: undefined as number | undefined }],
  liveGuests: new Set<string>(),
}));
vi.mock("~/hooks/useSettings", () => ({ useClientSettingsHydrated: () => true }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("./browserDefaults", () => ({ useBrowserDefaults: () => ({ profileId: "default" }) }));
vi.mock("../chatGPTBrowserSessions", () => ({
  useChatGPTBrowserSessions: () => ({ sessions: mocks.sessions }),
  chatGPTBrowserThreadRef: (_env: string, id: string) => ({ threadId: `t3-browser-session:${id}` }),
}));
vi.mock("./HostedBrowserWebview", () => ({
  HostedBrowserWebview: ({ runtimeTabId }: { runtimeTabId: string }) => {
    useEffect(() => {
      mocks.liveGuests.add(runtimeTabId);
      return () => {
        mocks.liveGuests.delete(runtimeTabId);
      };
    }, [runtimeTabId]);
    return null;
  },
}));

import {
  requestChatGPTDeliveryMount,
  releaseChatGPTDeliveryMount,
  useChatGPTDeliveryMountRequests,
} from "../chatGPTDeliveryMountRequest";
import { AuthorizedBrowserWebview } from "./ChatGPTGuestWebviewGate";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { useChatGPTGuestHibernation } from "./chatGPTGuestHibernation";

const runtimeTabId = JSON.stringify(["env", "t3-browser-session:session", "epoch", "tab"]);
const guestKey = JSON.stringify(["env", "t3-browser-session:session"]);
const owner = Symbol("selected guest");
const renderGuest = () => (
  <AuthorizedBrowserWebview
    threadRef={{
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("t3-browser-session:session"),
    }}
    tabId="tab"
    runtimeTabId={runtimeTabId}
    initialUrl="https://chatgpt.com/"
    viewport={{ _tag: "fill" }}
    pictureInPicture={false}
    profileId="default"
    zoomFactor={1}
  />
);
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  mocks.sessions = [{ id: "session", snoozedUntil: undefined }];
  mocks.liveGuests.clear();
  useChatGPTDeliveryMountRequests.setState({ required: {} });
  useChatGPTGuestHibernation.setState({
    hibernated: {},
    woken: { [guestKey]: true },
    retained: { [guestKey]: true },
    touchedAt: {},
  });
  const surface = useBrowserSurfaceStore.getState();
  surface.claim(runtimeTabId, owner, false);
  surface.present(runtimeTabId, owner, { x: 0, y: 0, width: 1, height: 1 }, true, 0, 0);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  useBrowserSurfaceStore.getState().release(runtimeTabId, owner);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("immediately unmounts a snoozed guest even when selected and retained, and reattaches on unsnooze", async () => {
  await act(async () => {
    renderer = create(renderGuest());
  });
  expect(mocks.liveGuests.has(runtimeTabId)).toBe(true);
  mocks.sessions[0]!.snoozedUntil = Date.now() + 60_000;
  await act(async () => {
    renderer!.update(renderGuest());
  });
  expect(mocks.liveGuests.size).toBe(0);
  mocks.sessions[0]!.snoozedUntil = undefined;
  await act(async () => {
    renderer!.update(renderGuest());
  });
  expect(mocks.liveGuests.has(runtimeTabId)).toBe(true);
});

it("keeps a restored snoozed guest unmounted until its snooze expires", async () => {
  mocks.sessions[0]!.snoozedUntil = Date.now() + 60_000;
  await act(async () => {
    renderer = create(renderGuest());
  });
  expect(mocks.liveGuests.size).toBe(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(mocks.liveGuests.has(runtimeTabId)).toBe(true);
});

it("mounts a cold snoozed background recipient for delivery without selecting it", async () => {
  mocks.sessions[0]!.snoozedUntil = Date.now() + 60_000;
  useBrowserSurfaceStore.getState().release(runtimeTabId, owner);
  useChatGPTGuestHibernation.setState({
    hibernated: { [guestKey]: true },
    woken: {},
    retained: {},
  });
  await act(async () => {
    renderer = create(renderGuest());
  });
  expect(mocks.liveGuests.size).toBe(0);
  await act(async () => requestChatGPTDeliveryMount("env", "session"));
  expect(mocks.liveGuests.has(runtimeTabId)).toBe(true);
  expect(useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible).not.toBe(true);
  await act(async () => releaseChatGPTDeliveryMount("env", "session"));
  expect(mocks.liveGuests.size).toBe(0);
});
