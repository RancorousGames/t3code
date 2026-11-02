import { describe, expect, it } from "vite-plus/test";
import {
  applyChatGPTBootstrapTitle,
  applyChatGPTBootstrapObservation,
  applyChatGPTBootstrapRegistryTitle,
  type BrowserSession,
} from "./chatGPTBrowserSessions";
import { needsChatGPTBootstrapMarker } from "./chatGPTBootstrapIdentity";

const canonicalId = "6d50bdf7-bc79-4a94-a938-657f65ee390e";

describe("Bootstrap agent-suggested sidebar titles", () => {
  it("applies a descriptive title once without changing the ID or other metadata", () => {
    const session: BrowserSession = { id: canonicalId, title: "ChatGPT 1", project: "t3code" };
    const titled = applyChatGPTBootstrapTitle(session, "  Implement   audio curation  ");
    expect(titled).toEqual({
      ...session, title: "Implement audio curation", titleSource: "bootstrap",
    });
    expect(applyChatGPTBootstrapTitle(titled, "Second title")).toBe(titled);
    expect(session.title).toBe("ChatGPT 1");
  });

  it("never overrides a title explicitly renamed by the user", () => {
    const renamed: BrowserSession = {
      id: canonicalId, title: "My own title", titleSource: "user",
    };
    expect(applyChatGPTBootstrapTitle(renamed, "Automated replacement")).toBe(renamed);
  });

  it("does not lose a manual title when the ID arrives earlier in the streamed response", () => {
    const conversationId = "f3078073-c343-45a1-92c6-362369458196";
    const initial: BrowserSession = {
      id: canonicalId, title: "ChatGPT 1", creationOrigin: "manual",
      bootstrapIdentity: { state: "awaiting_marker" },
    };
    const first = applyChatGPTBootstrapObservation([initial], canonicalId, {
      conversationId, markerId: canonicalId,
    });
    expect(first[0]?.bootstrapIdentity?.state).toBe("registered");
    expect(needsChatGPTBootstrapMarker(first[0]!)).toBe(true);
    const wrongConversation = applyChatGPTBootstrapObservation(first, canonicalId, {
      conversationId: "e306728c-f16e-4c32-9c9d-456737073f26", markerId: canonicalId,
      proposedTitle: "Wrong conversation",
    });
    expect(wrongConversation).toBe(first);
    const wrongId = applyChatGPTBootstrapObservation(first, canonicalId, {
      conversationId, markerId: "c13fa1bc-bec7-4168-8678-a98544799bc9",
      proposedTitle: "Wrong ID",
    });
    expect(wrongId).toBe(first);
    const finished = applyChatGPTBootstrapObservation(first, canonicalId, {
      conversationId, markerId: canonicalId, proposedTitle: "Review camera controls",
    });
    expect(finished[0]?.title).toBe("Review camera controls");
    expect(finished[0]?.titleSource).toBe("bootstrap");
    expect(needsChatGPTBootstrapMarker(finished[0]!)).toBe(false);
    expect(applyChatGPTBootstrapObservation(finished, canonicalId, {
      conversationId, markerId: canonicalId, proposedTitle: "Overwrite",
    })).toBe(finished);
  });

  it("expires pending title observation and never overrides manual renames", () => {
    const conversationId = "f3078073-c343-45a1-92c6-362369458196";
    const pending: BrowserSession = {
      id: canonicalId, title: "Human title", titleSource: "user",
      bootstrapIdentity: { state: "registered", publicId: canonicalId,
        conversationId, titlePendingUntil: Date.now() + 60_000 },
    };
    expect(needsChatGPTBootstrapMarker(pending)).toBe(false);
    const attempted = applyChatGPTBootstrapObservation([pending], canonicalId, {
      conversationId, markerId: canonicalId, proposedTitle: "Bot title",
    });
    expect(attempted[0]).toBe(pending);
    const expired: BrowserSession = { ...pending, titleSource: undefined,
      bootstrapIdentity: { ...pending.bootstrapIdentity!, titlePendingUntil: Date.now() - 1 } };
    expect(needsChatGPTBootstrapMarker(expired)).toBe(false);
    expect(applyChatGPTBootstrapObservation([expired], canonicalId, {
      conversationId, markerId: canonicalId, proposedTitle: "Late title",
    })[0]).toBe(expired);
  });

  it("resolves a persisted Bootstrap title only for the matching registered ID and conversation", () => {
    const conversationId = "f3078073-c343-45a1-92c6-362369458196";
    const session: BrowserSession = {
      id: "internal-browser-id", title: "ChatGPT 1",
      bootstrapIdentity: { state: "registered", publicId: canonicalId, conversationId },
    };
    const sessions = [session];
    expect(applyChatGPTBootstrapRegistryTitle(sessions, session.id, canonicalId, "other", "Saved title")).toBe(sessions);
    expect(applyChatGPTBootstrapRegistryTitle(sessions, session.id, "wrong", conversationId, "Saved title")).toBe(sessions);
    const updated = applyChatGPTBootstrapRegistryTitle(sessions, session.id, canonicalId, conversationId, "Saved title");
    expect(updated[0]).toMatchObject({ title: "Saved title", titleSource: "bootstrap" });
    expect(updated[0]?.id).toBe(session.id);
    expect(applyChatGPTBootstrapRegistryTitle(updated, session.id, canonicalId, conversationId, "Later title")).toBe(updated);
    expect(applyChatGPTBootstrapRegistryTitle([{ ...session, titleSource: "user" }], session.id, canonicalId, conversationId, "Saved title")[0]?.title).toBe(session.title);
  });

  it("rejects malformed suggestions without interfering with registration", () => {
    const session: BrowserSession = { id: canonicalId, title: "Existing" };
    for (const value of [" ", "a", "bad\nnewline", "[T3_ID:x]", "x".repeat(81)]) {
      expect(applyChatGPTBootstrapTitle(session, value)).toBe(session);
    }
  });
});
