import { expect, it } from "vite-plus/test";
import { resolveChatGPTView } from "./chatGPTSessionViewPreferences";

it("honors the saved Session/Browser choice regardless of later page observations", () => {
  expect(resolveChatGPTView("session", "session")).toBe("session");
  expect(resolveChatGPTView("browser", "session")).toBe("session");
  expect(resolveChatGPTView("session", "browser")).toBe("browser");
  expect(resolveChatGPTView("browser", "browser")).toBe("browser");
});

it("only consults the global default for a session not yet pinned", () => {
  expect(resolveChatGPTView("session", "default")).toBe("session");
  expect(resolveChatGPTView("browser", "default")).toBe("browser");
});
