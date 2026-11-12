import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import { delegatedChatGPTStopExpression } from "./stopExpression";

it("stops only an enabled visible control in the delegated conversation", () => {
  const conversationId = "00000000-0000-4000-8000-000000000010";
  let clicks = 0;
  class Button {
    disabled = false;
    visible = true;
    getClientRects() {
      return this.visible ? [{}] : [];
    }
    click() {
      clicks++;
    }
  }
  const button = new Button();
  const context = {
    location: { protocol: "https:", hostname: "chatgpt.com", pathname: `/c/${conversationId}/` },
    HTMLButtonElement: Button,
    document: { querySelector: () => button },
  };
  const expression = delegatedChatGPTStopExpression(conversationId);
  expect(NodeVM.runInNewContext(expression, context)).toBe(true);
  expect(clicks).toBe(1);
  button.disabled = true;
  expect(NodeVM.runInNewContext(expression, context)).toBe(false);
  button.disabled = false;
  button.visible = false;
  expect(NodeVM.runInNewContext(expression, context)).toBe(false);
  context.location.pathname = "/c/another-conversation";
  expect(() => NodeVM.runInNewContext(expression, context)).toThrow("conversation changed");
  expect(clicks).toBe(1);
});
