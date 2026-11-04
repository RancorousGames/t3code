// @vitest-environment node
// @ts-expect-error -- jsdom types are absent in this workspace; use the same DOM fixture as the session tests.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  findChatGPTSessionByAnyId,
  type IdentifiedSession,
  inspectChatGPTBootstrapMarker,
  inspectChatGPTBootstrapToolResult,
  inspectChatGPTBootstrapMarkerViaApi,
  nextChatGPTBootstrapGeneration,
  registerChatGPTBootstrapMarker,
  toInternalChatGPTIds,
  toPublicChatGPTIds,
} from "./chatGPTBootstrapIdentity";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const marker = `[T3_ID:${id}]`;
let closeDOM: () => void;
beforeEach(() => {
  const dom = new JSDOM("<!doctype html><body></body>");
  closeDOM = () => dom.window.close();
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("location", { hostname: "chatgpt.com", pathname: `/c/${conversationId}` });
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{ width: 100, height: 20 }] as unknown as DOMRectList);
});
afterEach(() => { closeDOM(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("first explicit rendered assistant bootstrap identity", () => {
  it("waits for a complete streamed marker without trusting user text", () => {
    document.body.innerHTML = `<div data-message-author-role="user">${marker}</div><div data-message-author-role="assistant"><div class="markdown">[T3_ID:111</div></div>`;
    expect(inspectChatGPTBootstrapMarker()).toBeNull();
    document.querySelector(".markdown")!.innerHTML = `<p>${marker}</p><p>Beginning work.</p>`;
    expect(inspectChatGPTBootstrapMarker()).toEqual({ conversationId, markerId: id });
  });

  it("finds a marker emitted in a later assistant response, not a user quote or tool card", () => {
    document.body.innerHTML = `
      <div data-message-author-role="user">${marker}</div>
      <div data-message-author-role="assistant">
        <div data-testid="tool-result">${marker}</div>
        <div class="markdown"><blockquote>${marker}</blockquote><pre>${marker}</pre><span hidden>${marker}</span>First response</div>
      </div>
      <div data-message-author-role="user">Now Bootstrap and print your ID.</div>
      <div data-message-author-role="assistant">
        <div class="markdown"><p>${marker}</p><p>Continuing the task.</p></div>
      </div>`;
    expect(inspectChatGPTBootstrapMarker()).toEqual({ conversationId, markerId: id });
  });

  it("accepts an inline prose marker, ignores code/quotes, and the first eligible reply wins", () => {
    document.body.innerHTML = `
      <div data-message-author-role="assistant"><div class="markdown">
        <pre>[T3_ID:${other}]</pre><blockquote>[T3_ID:${other}]</blockquote>
      </div></div>
      <div data-message-author-role="assistant"><div class="markdown"><p>Bootstrapped: ${marker}</p></div></div>
      <div data-message-author-role="assistant"><div class="markdown"><p>[T3_ID:${other}]</p></div></div>`;
    expect(inspectChatGPTBootstrapMarker()).toEqual({ conversationId, markerId: id });
  });

  it("detects an assistant-styled markdown sibling outside an empty modern assistant unit", () => {
    document.body.innerHTML = `
      <div data-content-search-unit-key="turn1:user">Starting work</div>
      <div data-content-search-unit-key="turn1:assistant"></div>
      <div data-markdown-text-style="assistant-message"><p>${marker}</p></div>`;
    expect(inspectChatGPTBootstrapMarker()).toEqual({ conversationId, markerId: id });
  });

  it("never accepts untrusted generic markdown outside a verified assistant unit", () => {
    document.body.innerHTML = `
      <div data-content-search-unit-key="turn1:assistant"></div>
      <div class="markdown"><p>${marker}</p></div>`;
    expect(inspectChatGPTBootstrapMarker()).toBeNull();
  });

  it("supports ChatGPT project conversation URLs", () => {
    document.body.innerHTML = `<div data-message-author-role="assistant"><p>${marker}</p></div>`;
    vi.stubGlobal("location", { hostname: "chatgpt.com", pathname: `/g/g-p-abc123/c/${conversationId}` });
    expect(inspectChatGPTBootstrapMarker()).toEqual({ conversationId, markerId: id });
  });

  it("finds the final assistant paragraph even when the tool card has its own markdown", () => {
    document.body.innerHTML = `
      <div data-message-author-role="assistant">
        <div data-testid="tool-result"><div class="markdown"><p>[T3_ID:${other}]</p></div></div>
        <div class="markdown"><p>${marker}</p><p>Bootstrapped successfully.</p></div>
      </div>`;
    expect(inspectChatGPTBootstrapMarker()).toEqual({ conversationId, markerId: id });
  });

  it("pairs an immediately following title marker with the same assistant ID reply", () => {
    document.body.innerHTML = `
      <div data-message-author-role="assistant">
        <div data-testid="tool-result"><p>[T3_TITLE:Wrong tool title]</p></div>
        <div class="markdown">
          <p>${marker}</p><p>[T3_TITLE:Repair T3 session routing]</p>
          <p>Continuing the implementation.</p>
        </div>
      </div>`;
    expect(inspectChatGPTBootstrapMarker()).toEqual({
      conversationId, markerId: id, proposedTitle: "Repair T3 session routing",
    });
    document.querySelector(".markdown")!.innerHTML =
      `<p>${marker}</p><p>Actual reply.</p><p>[T3_TITLE:Stray example]</p>`;
    expect(inspectChatGPTBootstrapMarker()).toEqual({ conversationId, markerId: id });
  });

  it("detects real role-unit text without a markdown wrapper and ignores nested tool output", () => {
    document.body.innerHTML = `
      <div data-content-search-unit-key="turn-1:assistant">
        <div data-testid="tool-result"><span>[T3_ID:${other}]</span></div>
        <div><span>${marker}</span></div><div>I'll select a task.</div>
      </div>`;
    expect(inspectChatGPTBootstrapMarker()).toEqual({ conversationId, markerId: id });
  });

  it("rejects user and tool-only units even without a markdown wrapper", () => {
    document.body.innerHTML = `
      <div data-message-author-role="user"><div>${marker}</div></div>
      <div data-content-search-unit-key="turn-2:assistant">
        <div data-testid="tool-output"><span>${marker}</span></div>
        <blockquote><span>${marker}</span></blockquote>
        <pre><span>${marker}</span></pre>
      </div>`;
    expect(inspectChatGPTBootstrapMarker()).toBeNull();
  });

  it("does not interpret tool-only or quoted markers as a Bootstrap registration", () => {
    document.body.innerHTML = `
      <div data-message-author-role="user"><div class="markdown"><p>${marker}</p></div></div>
      <div data-message-author-role="assistant"><div data-testid="tool-result"><p>${marker}</p></div>
        <div class="markdown"><blockquote><p>${marker}</p></blockquote><pre>${marker}</pre></div>
      </div>`;
    expect(inspectChatGPTBootstrapMarker()).toBeNull();
  });

  it("supports explicit assistant search units without treating a nested user quote as assistant output", () => {
    document.body.innerHTML = `<div data-content-search-unit-key="turn:assistant"><div class="prose">${marker}</div></div>`;
    expect(inspectChatGPTBootstrapMarker()?.markerId).toBe(id);
    document.body.innerHTML = `<div data-message-author-role="user">${document.body.innerHTML}</div>`;
    expect(inspectChatGPTBootstrapMarker()).toBeNull();
  });

  it("recognizes assistant text in conversation-turn wrappers lacking explicit role attributes", () => {
    document.body.innerHTML = `
      <article data-testid="conversation-turn-1">
        <div class="whitespace-pre-wrap">${marker}</div>
      </article>
      <article data-testid="conversation-turn-2">
        <div class="markdown"><p>${marker}</p></div>
      </article>`;
    expect(inspectChatGPTBootstrapMarker()).toEqual({ conversationId, markerId: id });
  });

  it("does not register a marker on another origin or the new-chat homepage", () => {
    document.body.innerHTML = `<div data-message-author-role="assistant"><div class="markdown">${marker}</div></div>`;
    vi.stubGlobal("location", { hostname: "example.com", pathname: `/c/${conversationId}` });
    expect(inspectChatGPTBootstrapMarker()).toBeNull();
    vi.stubGlobal("location", { hostname: "chatgpt.com", pathname: "/" });
    expect(inspectChatGPTBootstrapMarker()).toBeNull();
  });

});

describe("Bootstrap tool-result registration", () => {

  it("registers directly from a completed Bootstrap tool card before an assistant reply", () => {
    document.body.innerHTML =
      '<div data-testid="tool-result">T3 session ID: ' + id +
      '\nID marker: ' + marker +
      '\nProposed title: Repair T3 registration\nRole: worker</div>';
    expect(inspectChatGPTBootstrapToolResult()).toEqual({
      conversationId, markerId: id, proposedTitle: "Repair T3 registration",
    });
    document.body.innerHTML = '<div data-message-author-role="user"><div data-testid="tool-result">' +
      'T3 session ID: ' + id + '\nID marker: ' + marker + '\nRole: worker</div></div>';
    expect(inspectChatGPTBootstrapToolResult()).toBeNull();
  });

  it("registers a Bootstrap tool response from the conversation API before assistant output", async () => {
    const toolText = "T3 session ID: " + id + "\nID marker: " + marker +
      "\nProposed title: Repair T3 registration\nRole: worker\nComplete: true";
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        mapping: {
          user: { message: { author: { role: "user" }, content: { parts: [toolText] } } },
          tool: { message: { author: { role: "tool", name: "mcp__OMCP_Tools__Bootstrap" },
            content: { content_type: "text", parts: [toolText] } } },
        },
      }) });
    vi.stubGlobal("fetch", fetch);
    await expect(inspectChatGPTBootstrapMarkerViaApi()).resolves.toEqual({
      conversationId, markerId: id, proposedTitle: "Repair T3 registration",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });


  it("recognizes a Bootstrap receipt wrapped by functions.exec", async () => {
    const receipt = JSON.stringify({ structuredContent: {
      id, marker, role: "worker", title: "Repair T3 registration", complete: true,
    } });
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        mapping: {
          tool: { message: { author: { role: "tool", name: "functions.exec" },
            content: { content_type: "text", parts: [receipt] } } },
        },
      }) });
    vi.stubGlobal("fetch", fetch);
    await expect(inspectChatGPTBootstrapMarkerViaApi()).resolves.toEqual({
      conversationId, markerId: id, proposedTitle: "Repair T3 registration",
    });
  });

  it("does not associate a copied Bootstrap result from a user or unrelated tool", async () => {
    const toolText = "T3 session ID: " + id + "\nID marker: " + marker + "\nRole: worker";
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accessToken: "test-token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        mapping: {
          user: { message: { author: { role: "user" }, content: { parts: [toolText] } } },
          unrelated: { message: { author: { role: "tool", name: "unrelated_tool" },
            content: { content_type: "text", parts: [toolText] } } },
        },
      }) });
    vi.stubGlobal("fetch", fetch);
    await expect(inspectChatGPTBootstrapMarkerViaApi()).resolves.toBe("api_no_marker");
  });
});

describe("public Bootstrap IDs", () => {
  const internal = "44444444-4444-4444-8444-444444444444";
  const seen = { conversationId, markerId: id };

  it("adopts the first marker as a manual or legacy session's public ID, first wins", () => {
    const manual: IdentifiedSession = { id: internal, creationOrigin: "manual", bootstrapIdentity: { state: "awaiting_marker" } };
    const registered = registerChatGPTBootstrapMarker([manual], internal, seen)!;
    expect(registered.bootstrapIdentity).toMatchObject({ state: "registered", publicId: id, conversationId, reportedId: id });
    expect(registered.bootstrapIdentity?.titlePendingUntil).toBeGreaterThan(Date.now());
    expect(registerChatGPTBootstrapMarker([registered], internal, { conversationId, markerId: other })).toBeNull();
    const legacy = registerChatGPTBootstrapMarker<IdentifiedSession>([{ id: internal }], internal, seen)!;
    expect(legacy.bootstrapIdentity?.publicId).toBe(id);
  });

  it("never lets a marker steal another session's ID", () => {
    const sessions: IdentifiedSession[] = [{ id: internal }, { id }];
    expect(registerChatGPTBootstrapMarker(sessions, internal, seen)!.bootstrapIdentity)
      .toEqual({ state: "mismatch", conversationId, reportedId: id });
  });

  it("keeps a preassigned child ID and records a mismatch", () => {
    const child = { id, spawnRequestId: "req", bootstrapIdentity: { state: "awaiting_marker" as const, publicId: id } };
    const rejected = registerChatGPTBootstrapMarker([child], id, { conversationId, markerId: other })!;
    expect(rejected.bootstrapIdentity).toMatchObject({ state: "mismatch", publicId: id, reportedId: other });
    expect(registerChatGPTBootstrapMarker([rejected], id, seen)).toBeNull();
    expect(registerChatGPTBootstrapMarker([child], id, seen)!.bootstrapIdentity?.state).toBe("registered");
  });

  it("requires the same public ID again after reboot", () => {
    expect(nextChatGPTBootstrapGeneration(undefined)).toBeUndefined();
    const restarted = nextChatGPTBootstrapGeneration({ state: "registered", publicId: id, conversationId });
    expect(restarted).toEqual({ state: "awaiting_marker", publicId: id });
    const session = { id: internal, bootstrapIdentity: restarted };
    expect(registerChatGPTBootstrapMarker([session], internal, { conversationId: other, markerId: other })!
      .bootstrapIdentity?.state).toBe("mismatch");
  });

  it("translates IDs at the pipe boundary", () => {
    const sessions = [{ id: internal, bootstrapIdentity: { state: "registered" as const, publicId: id } }];
    expect(findChatGPTSessionByAnyId(sessions, id.toUpperCase())?.id).toBe(internal);
    expect(toInternalChatGPTIds({ sessionId: id, senderSessionId: "other", message: id }, sessions))
      .toEqual({ sessionId: internal, senderSessionId: "other", message: id });
    expect(toPublicChatGPTIds({ sessions: [{ id: internal, parentSessionId: internal }], n: 1 }, sessions))
      .toEqual({ sessions: [{ id, parentSessionId: id }], n: 1 });
  });
});
