// @vitest-environment node
// @ts-expect-error jsdom's runtime types are not installed in this workspace.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CHATGPT_RECOVERY_INTERVAL_BOUNDS,
  DEFAULT_CHATGPT_RECOVERY_SETTINGS,
  readChatGPTRecoverySettings,
  updateChatGPTRecoverySettings,
  validRecoverySettingNumber,
} from "./chatGPTRecoverySettings";

let dom: JSDOM;
beforeEach(() => {
  dom = new JSDOM("", { url: "https://localhost" });
  vi.stubGlobal("window", dom.window);
});
afterEach(() => {
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("custom ChatGPT recovery intervals", () => {
  it("retains valid non-preset intervals across external reads", () => {
    updateChatGPTRecoverySettings({
      watchdogSeconds: 173,
      globalSeconds: 47,
      orangeGlobalSeconds: 91,
      perSessionSeconds: 317,
      orangeGraceMinutes: 7,
      missingComposerSeconds: 83,
    });
    const actual = readChatGPTRecoverySettings();
    expect(actual).toMatchObject({
      watchdogSeconds: 173,
      globalSeconds: 47,
      orangeGlobalSeconds: 91,
      perSessionSeconds: 317,
      orangeGraceMinutes: 7,
      missingComposerSeconds: 83,
    });
    expect(JSON.parse(window.localStorage.getItem("t3code:chatgpt-browser:recovery-preferences:v1")!))
      .toMatchObject({ watchdogSeconds: 173, orangeGlobalSeconds: 91 });
  });

  it("rejects zero, negative, fractional, out-of-range and nonfinite values", () => {
    updateChatGPTRecoverySettings({ watchdogSeconds: 132, globalSeconds: 47 });
    updateChatGPTRecoverySettings({
      watchdogSeconds: 0,
      globalSeconds: -3,
      orangeGlobalSeconds: 99999,
      perSessionSeconds: 1.5,
      orangeGraceMinutes: Number.POSITIVE_INFINITY,
      missingComposerSeconds: NaN,
    });
    expect(readChatGPTRecoverySettings()).toMatchObject({
      watchdogSeconds: 132,
      globalSeconds: 47,
      orangeGlobalSeconds: DEFAULT_CHATGPT_RECOVERY_SETTINGS.orangeGlobalSeconds,
      perSessionSeconds: DEFAULT_CHATGPT_RECOVERY_SETTINGS.perSessionSeconds,
    });
    for (const [key, bounds] of Object.entries(CHATGPT_RECOVERY_INTERVAL_BOUNDS)) {
      const field = key as keyof typeof CHATGPT_RECOVERY_INTERVAL_BOUNDS;
      expect(validRecoverySettingNumber(field, bounds[0])).toBe(true);
      expect(validRecoverySettingNumber(field, bounds[1])).toBe(true);
      expect(validRecoverySettingNumber(field, bounds[0] - 1)).toBe(false);
      expect(validRecoverySettingNumber(field, bounds[1] + 1)).toBe(false);
    }
  });

  it("migrates legacy 20-second scans into 120-second watchdogs", () => {
    window.localStorage.setItem("t3code:chatgpt-browser:recovery-preferences:v1",
      JSON.stringify({ scanSeconds: 20, globalSeconds: 43 }));
    expect(readChatGPTRecoverySettings()).toMatchObject({ watchdogSeconds: 120, globalSeconds: 43 });
  });

  it("returns safe defaults when browser storage itself is denied", () => {
    vi.stubGlobal("window", {
      get localStorage() { throw new Error("SecurityError"); },
    });
    const denied = readChatGPTRecoverySettings();
    expect(denied).toEqual({ ...DEFAULT_CHATGPT_RECOVERY_SETTINGS, paused: true });
    expect(readChatGPTRecoverySettings()).toBe(denied);
    // An absent optional browser API is not permission to auto-resume recovery.
    expect(() => updateChatGPTRecoverySettings({ paused: false })).not.toThrow();
  });
  it("reverts invalid stored legacy intervals without disabling recovery", () => {
    window.localStorage.setItem("t3code:chatgpt-browser:recovery-preferences:v1",
      JSON.stringify({ watchdogSeconds: 0, perSessionSeconds: "abc", paused: true, targetCount: 2 }));
    expect(readChatGPTRecoverySettings()).toMatchObject({
      watchdogSeconds: DEFAULT_CHATGPT_RECOVERY_SETTINGS.watchdogSeconds,
      perSessionSeconds: DEFAULT_CHATGPT_RECOVERY_SETTINGS.perSessionSeconds,
      paused: true,
      targetCount: 2,
    });
  });
});
