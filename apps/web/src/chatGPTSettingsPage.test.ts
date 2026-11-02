import { describe, expect, it } from "vitest";
import { isChatGPTSettingsUrl } from "./chatGPTBrowserPrewarm";
import { deriveChatGPTSession } from "./chatGPTSessionModel";

describe("ChatGPT settings page", () => {
  it("recognizes the real settings URL without matching conversations or unrelated hosts", () => {
    expect(isChatGPTSettingsUrl("https://chatgpt.com/settings/general-settings")).toBe(true);
    expect(isChatGPTSettingsUrl("https://chatgpt.com/settings")).toBe(true);
    expect(isChatGPTSettingsUrl("https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc")).toBe(false);
    expect(isChatGPTSettingsUrl("https://chatgpt.com/settings-other")).toBe(false);
    expect(isChatGPTSettingsUrl("https://example.org/settings/general-settings")).toBe(false);
  });

  it("does not raise a recovery error when settings deliberately lacks a composer", () => {
    const session = deriveChatGPTSession({ status: "settings", age: "invalid", attached: true }, Date.now());
    expect(session.activity).toBe("unknown");
    expect(session.attention).toBe("none");
    expect(session.bucket).toBe("idle");
    expect(session.compatibilityAge).toBe("unknown");
    expect(session.primaryAction).toBe("open");
    expect(session.statusLine).toBe("ChatGPT settings open");
  });
});
