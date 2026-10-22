import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  activeSessionId: undefined as string | undefined,
  sessions: [] as { id: string; hidden?: boolean; snoozedUntil?: number }[],
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: ({
    select,
  }: {
    select: (params: { browserSessionId?: string | undefined }) => unknown;
  }) => select({ browserSessionId: mocks.activeSessionId }),
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "env" }));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../chatGPTBrowserSessions", () => ({
  useChatGPTBrowserSessions: () => ({ sessions: mocks.sessions }),
  chatGPTBrowserThreadRef: (_environmentId: string, id: string) => ({
    threadId: `t3-browser-session:${id}`,
  }),
  chatGPTBrowserLastWorkingKey: (_environmentId: string, id: string) => `working:${id}`,
}));
vi.mock("../../hooks/useLocalStorage", () => ({ getLocalStorageItem: () => 0 }));

import {
  isChatGPTGuestHibernated,
  useChatGPTGuestHibernation,
} from "../../browser/chatGPTGuestHibernation";
import { ChatGPTGuestRetention } from "./ChatGPTGuestRetention";

const key = (id: string) => JSON.stringify(["env", `t3-browser-session:${id}`]);
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.activeSessionId = undefined;
  mocks.sessions = Array.from({ length: 8 }, (_, i) => ({ id: `${i}` }));
  useChatGPTGuestHibernation.setState({
    hibernated: Object.fromEntries(mocks.sessions.map(({ id }) => [key(id), true])),
    touchedAt: Object.fromEntries(mocks.sessions.map(({ id }, i) => [key(id), i * 1_000])),
    retained: {},
    woken: {},
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
});

describe("ChatGPT recent guest retention", () => {
  it("restores the latest five after restart and updates the set when an old session is selected", async () => {
    await act(async () => {
      renderer = create(<ChatGPTGuestRetention />);
    });
    for (const id of ["7", "6", "5", "4", "3"])
      expect(isChatGPTGuestHibernated(key(id))).toBe(false);
    expect(isChatGPTGuestHibernated(key("2"))).toBe(true);
    expect(useChatGPTGuestHibernation.getState().touchedAt[key("7")]).toBe(7_000);

    mocks.activeSessionId = "0";
    await act(async () => {
      renderer!.update(<ChatGPTGuestRetention />);
    });
    expect(isChatGPTGuestHibernated(key("0"))).toBe(false);
    expect(isChatGPTGuestHibernated(key("3"))).toBe(true);
  });

  it("skips hidden and snoozed sessions and restores a session when its snooze expires", async () => {
    mocks.sessions[7]!.hidden = true;
    mocks.sessions[6]!.snoozedUntil = Date.now() + 30_000;
    await act(async () => {
      renderer = create(<ChatGPTGuestRetention />);
    });
    expect(isChatGPTGuestHibernated(key("7"))).toBe(true);
    expect(isChatGPTGuestHibernated(key("6"))).toBe(true);
    for (const id of ["5", "4", "3", "2", "1"])
      expect(isChatGPTGuestHibernated(key(id))).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(isChatGPTGuestHibernated(key("6"))).toBe(false);
    expect(isChatGPTGuestHibernated(key("1"))).toBe(true);
  });
});
