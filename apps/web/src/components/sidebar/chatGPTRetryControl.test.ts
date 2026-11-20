// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { operateChatGPTRetryControl } from "./chatGPTRetryControl";

beforeEach(() => {
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("ChatGPT provider Retry control", () => {
  it("clicks only a visible enabled Retry and reports provider-disabled states", () => {
    document.body.innerHTML = '<main><button type="button">Try again</button></main>';
    const button = document.querySelector("button")!;
    const clicked = vi.fn();
    button.addEventListener("click", clicked);
    expect(operateChatGPTRetryControl(false)).toBe("ready");
    expect(clicked).not.toHaveBeenCalled();
    expect(operateChatGPTRetryControl(true)).toBe("clicked");
    expect(clicked).toHaveBeenCalledTimes(1);
    button.disabled = true;
    expect(operateChatGPTRetryControl(true)).toBe("disabled");
    expect(clicked).toHaveBeenCalledTimes(1);
    button.disabled = false;
    button.setAttribute("aria-disabled", "true");
    expect(operateChatGPTRetryControl(true)).toBe("disabled");
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("never clicks a normal conversation, a missing button or a hidden Retry", () => {
    document.body.innerHTML = "<main><p>Try again</p></main>";
    expect(operateChatGPTRetryControl(true)).toBe("missing");
    document.body.innerHTML = "<main><button hidden>Try again</button></main>";
    expect(operateChatGPTRetryControl(true)).toBe("missing");
  });
});
