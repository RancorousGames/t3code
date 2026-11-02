import { describe, expect, it } from "vite-plus/test";
import { answerChatGPTSessionQuestion, readChatGPTSessionQuestion, requestChatGPTSessionQuestion } from "./chatGPTSessionQuestion";

const ID = "a0d1357c-4c8b-462f-86e1-d7f5e1578220";
const OTHER = "de08ca66-490c-4114-9ecf-001fcc4ab2dc";
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}
describe("ChatGPT session question", () => {
  it("persists one pending question and refuses to overwrite it with a new ID", () => {
    const store = memoryStorage();
    const input = { id: ID, prompt: "Which settlement?", options: ["North", "South"], allowCustom: true };
    expect(requestChatGPTSessionQuestion("env", "session", input, store, 100).status).toBe("pending");
    expect(requestChatGPTSessionQuestion("env", "session", input, store, 110).askedAt).toBe(100);
    expect(() => requestChatGPTSessionQuestion("env", "session", { ...input, id: OTHER }, store)).toThrow(/unanswered/);
    expect(readChatGPTSessionQuestion("env", "other", store)).toBeNull();
  });
  it("answers only the selected question and keeps the queue message receipt", () => {
    const store = memoryStorage();
    requestChatGPTSessionQuestion("env", "session",
      { id: ID, prompt: "Select one", options: ["Yes", "No"], allowCustom: false }, store, 100);
    expect(() => answerChatGPTSessionQuestion("env", "session", ID, "Maybe", OTHER, store)).toThrow(/provided options/);
    const answered = answerChatGPTSessionQuestion("env", "session", ID, "Yes", OTHER, store, 200);
    expect(answered.status).toBe("answered");
    expect(answered.answerMessageId).toBe(OTHER);
    expect(answerChatGPTSessionQuestion("env", "session", ID, "Yes", OTHER, store)).toEqual(answered);
    expect(() => answerChatGPTSessionQuestion("env", "session", ID, "No", OTHER, store)).toThrow(/already/);
  });
});
