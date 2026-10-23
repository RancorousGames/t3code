import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "./app-context.ts";
import { CodexTranslationPanel } from "./CodexTranslationPanel.tsx";
import { Icon } from "./Icons.tsx";
import {
  createChatSession, loadChatSessions, normalizedChatGPTUrl, saveChatSessions,
  type MoriChatSession,
} from "./chatgpt-sessions.ts";
import { chatGPTWebviewAutomation } from "../../web/src/chatGPTWebviewAutomation.ts";
import { inspectChatGPTPage, type PageInspection } from "../../web/src/chatGPTSessionDom.ts";
// The send receipt matches the T3 chatGPTSessionMessaging user-turn rules.
const sentTurnObserved = (expected: string, messages: readonly { role: string; text: string }[], before: number, after: number) =>
  after > before && messages.some(message => message.role === "user" &&
    message.text.replace(/\\s+/g, " ").trim() === expected.replace(/\\s+/g, " ").trim());
import { chatGPTConversationIdFromUrl } from "../../web/src/chatGPTConversationIdentity.ts";
import { batchTranslationPrompt, nextDraftCandidates, parseBatchReply } from "./ai-batch.ts";

// Reuse T3's existing guest-side automation/inspection implementations; unlike
// T3's server sessions, these are browser-only subscription ChatGPT sessions.
// The Mori Electron host has its own, isolated persistent Chromium partition.
type Guest = HTMLElement & {
  getURL: () => string;
  executeJavaScript: (expression: string) => Promise<unknown>;
  isLoading?: () => boolean;
  loadURL?: (url: string) => Promise<void> | void;
};
const COMPOSER = [
  "#prompt-textarea", '[data-testid="prompt-textarea"]', '[data-testid="composer-input"]',
  '[contenteditable="true"][role="textbox"]', "div[contenteditable=true]", "textarea",
].join(", ");
const NEW_CHAT_URL = "https://chatgpt.com/";

function promptForLine(project: ReturnType<typeof useApp>["project"], rowId: string, instruction: string) {
  const row = project.rows.find(r => r.id === rowId);
  if (!row) throw Error("Choose a translation line first.");
  const speaker = project.characters.find(c => c.id === row.characterId);
  const terms = project.glossary.filter(t => t.en && row.source.toLowerCase().includes(t.en.toLowerCase()));
  return [
    "Help translate a game localization string from English into Japanese. You are assisting a human translator.",
    "Make a useful Japanese suggestion while preserving placeholders and control tokens. Do not edit existing human-curated text.",
    project.context.global ? "Global conventions:\n" + project.context.global : "",
    project.context.project ? "Game context:\n" + project.context.project : "",
    speaker ? `Character ${speaker.name}: role=${speaker.role}, tone=${speaker.tone}. ${speaker.description}` : "",
    terms.length ? "Required terms:\n" + terms.map(t => `${t.en} => ${t.jp} (${t.explanation})`).join("\n") : "",
    `String ID: ${row.id}`,
    `English source: ${row.source}`,
    row.legacy ? `Developer Japanese draft: ${row.legacy}` : "",
    row.final ? `Current human-curated text (reference only): ${row.final}` : "",
    `Request: ${instruction}`,
    "Return the best Japanese translation first, with brief optional notes after it.",
  ].filter(Boolean).join("\n\n");
}

export function ChatGPTScreen() {
  const { project, activeRow, actions, toast, go } = useApp();
  const [sessions, setSessions] = useState<MoriChatSession[]>(loadChatSessions);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState("Sign in to ChatGPT in the embedded browser with your own account.");
  const [inspection, setInspection] = useState<PageInspection | null>(null);
  const [prompt, setPrompt] = useState("");
  const [prepared, setPrepared] = useState<{ mode: "single" | "batch"; ids: string[]; text: string } | null>(null);
  const [pendingRequest, setPendingRequest] = useState<{ mode: "single" | "batch"; ids: string[]; text: string; sessionId: string } | null>(null);
  const view = useRef<Guest | null>(null);
  const sessionsRef = useRef(sessions);
  const relevant = sessions.filter(s => s.projectId === project.id);
  const active = relevant.find(s => s.id === activeId && !s.hidden) ??
    relevant.find(s => !s.hidden) ?? null;
  const runtimeId = active ? `mori-chatgpt:${active.id}` : "";
  const patchSessions = useCallback((edit: (list: MoriChatSession[]) => MoriChatSession[]) => {
    setSessions(current => {
      const next = edit(current);
      sessionsRef.current = next;
      saveChatSessions(next);
      return next;
    });
  }, []);

  const addChat = () => {
    const next = createChatSession(project.id);
    patchSessions(sessions => [...sessions, next]);
    setActiveId(next.id);
    setInspection(null);
    setPrepared(null);
    setPendingRequest(null);
  };
  const changeUrl = useCallback((id: string, url: string) => {
    const normalized = normalizedChatGPTUrl(url);
    if (!normalized) return;
    if (sessionsRef.current.find(session => session.id === id)?.url === normalized) return;
    patchSessions(sessions => sessions.map(s => s.id === id ? { ...s, url: normalized, changedAt: Date.now() } : s));
  }, [patchSessions]);

  useEffect(() => {
    setReady(false);
    setInspection(null);
    setStatus(active ? "Loading ChatGPT…" : "Open a conversation or start a new one.");
    const guest = view.current;
    if (!active || !guest) return;
    const id = active.id;
    const navigated = () => {
      const url = guest.getURL?.();
      if (url) changeUrl(id, url);
    };
    const loaded = () => {
      navigated();
      setReady(true);
      setStatus("ChatGPT is ready. You can chat directly, or send the selected line with its context.");
    };
    const titleChanged = (event: Event) => {
      const next = (event as Event & { title?: string }).title;
      if (!next || /^(ChatGPT|New chat)$/i.test(next)) return;
      const name = next.replace(/\s+[–—-]\s+ChatGPT$/, "").slice(0, 80);
      patchSessions(sessions => sessions.map(s => s.id === id ? { ...s, title: name } : s));
    };
    guest.addEventListener("dom-ready", loaded);
    guest.addEventListener("did-navigate", navigated);
    guest.addEventListener("did-navigate-in-page", navigated);
    guest.addEventListener("page-title-updated", titleChanged);
    return () => {
      guest.removeEventListener("dom-ready", loaded);
      guest.removeEventListener("did-navigate", navigated);
      guest.removeEventListener("did-navigate-in-page", navigated);
      guest.removeEventListener("page-title-updated", titleChanged);
    };
  }, [active?.id, changeUrl, patchSessions]);

  const inspect = useCallback(async (): Promise<PageInspection> => {
    const guest = view.current;
    if (!guest) throw Error("ChatGPT browser has not loaded.");
    const page = await guest.executeJavaScript(
      `(${inspectChatGPTPage.toString()})({from:"end",count:5,includeMessages:true,maxMessageChars:16000})`,
    ) as PageInspection;
    if (normalizedChatGPTUrl(page.url) === null) throw Error("The ChatGPT browser is not on a conversation page.");
    setInspection(page);
    return page;
  }, []);

  const check = async () => {
    setChecking(true);
    try {
      const page = await inspect();
      setStatus(`ChatGPT: ${page.activity}. ${page.totalTurns} rendered turns. Last: ${page.lastRole ?? "none"}.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "ChatGPT page inspection failed."); }
    finally { setChecking(false); }
  };

  const sendPrompt = async () => {
    if (!active || !prompt.trim() || !view.current || sending) return;
    const text = prompt.trim();
    if (text.length > 24_000) { setStatus("Prompt is too long. Shorten context before sending."); return; }
    setPendingRequest(null);
    let clicked = false;
    setSending(true);
    setStatus("Preparing ChatGPT composer…");
    try {
      const before = await inspect();
      const url = normalizedChatGPTUrl(before.url);
      const expected = chatGPTConversationIdFromUrl(before.url);
      if (!url || (!expected && url !== NEW_CHAT_URL)) throw Error("Open a ChatGPT chat before sending.");
      if (before.activity === "working" || before.connectionInterrupted) throw Error("Wait for the current ChatGPT response before sending.");
      await chatGPTWebviewAutomation.waitFor(runtimeId, { selector: COMPOSER, timeoutMs: 5000 });
      await chatGPTWebviewAutomation.type(runtimeId, {
        selector: COMPOSER,
        text, clear: true,
        expectedConversationId: expected ?? undefined,
      });
      // T3's click operation keeps the conversation-identity guard inside the guest turn.
      await chatGPTWebviewAutomation.press(runtimeId, {
        key: "Enter",
        expectedConversationId: expected ?? undefined,
      });
      clicked = true;
      if (prepared && prepared.text.trim() === text) setPendingRequest({ ...prepared, sessionId: active.id });
      setStatus("Submitted to ChatGPT. The reply will appear in the embedded conversation.");
      setPrompt("");
      setPrepared(null);
      // Best-effort non-mutating confirmation, not permission to retry.
      const after = await inspect();
      if (sentTurnObserved(text, after.messages, before.totalTurns, after.totalTurns)) {
        setStatus("ChatGPT confirmed your new user message.");
      }
    } catch (error) {
      setStatus(clicked
        ? "The ChatGPT send was clicked, but delivery was not confirmed. Check the chat before sending again."
        : (error instanceof Error ? error.message : "Could not send to ChatGPT."));
    } finally {
      setSending(false);
    }
  };

  const captureReply = async () => {
    const pending = pendingRequest;
    if (!pending || !active || pending.sessionId !== active.id) { toast("Prepare and send a translation request in this chat first."); return; }
    try {
      const latest = await inspect();
      if (latest.activity === "working" || latest.connectionInterrupted) throw Error("Wait for ChatGPT to finish responding.");
      const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
      const userTurn = [...latest.messages].reverse().find(message => message.role === "user" &&
        normalize(message.text) === normalize(pending.text));
      if (!userTurn) throw Error("The prepared request is not visible in this conversation. No AI draft was changed.");
      const reply = latest.messages.find(message => message.role === "assistant" && message.turn === userTurn.turn)?.text;
      if (!reply || latest.lastRole !== "assistant") throw Error("No completed assistant reply associated with that request.");
      const candidates = pending.mode === "batch" ?
        parseBatchReply(reply, pending.ids) : [{ id: pending.ids[0]!, japanese: reply }];
      if (candidates.some(item => project.rows.find(row => row.id === item.id)?.isLocked)) {
        throw Error("One or more requested rows are locked. Nothing was changed.");
      }
      const summary = candidates.map(item => `${item.id}: ${item.japanese.slice(0, 100)}`).join("\n");
      if (!window.confirm(`Review these ${candidates.length} AI draft suggestion(s). Curated translations remain untouched.\n\n${summary}\n\nSave as AI drafts?`)) return;
      for (const { id, japanese } of candidates) actions.updateRow(id, current => {
        if (current.isLocked) return current;
        return {
          ...current, ai: japanese,
          status: current.final.trim() ? "translated" : "draft",
          ...(current.ai && current.ai !== japanese
            ? { history: [...(current.history ?? []), { type: "ai" as const, text: current.ai, timestamp: Date.now() }] }
            : {}),
        };
      });
      setPendingRequest(null);
      toast(`Saved ${candidates.length} ChatGPT suggestion(s) as AI drafts; curated Japanese was not touched.`);
    } catch (error) { toast(error instanceof Error ? error.message : "Could not capture AI reply."); }
  };

  return (
    <div className="mori-chatgpt">
      <div className="mori-chat-top">
        <div>
          <h1>ChatGPT conversations</h1>
          <p>Uses the real ChatGPT browser and your own subscription. Chats stay separate from T3.</p>
        </div>
        <button type="button" className="btn outline sm" onClick={addChat}>+ New chat</button>
      </div>
      <CodexTranslationPanel />
      <div className="mori-chat-tabs">
        {relevant.map(s => (
          <div key={s.id} className="mori-chat-tab">
            <button type="button" className={s.id === active?.id ? "btn sm primary" : "btn sm"}
              onClick={() => {
                if (s.hidden) patchSessions(list => list.map(item => item.id === s.id ? { ...item, hidden: false } : item));
                setActiveId(s.id);
              }}>
              {s.hidden ? "↶ " : ""}{s.title}
            </button>
            {!s.hidden && <button type="button" className="ib" title="Hide tab (conversation URL is retained)"
              onClick={() => {patchSessions(list => list.map(item => item.id === s.id ? { ...item, hidden: true } : item));if (activeId === s.id) setActiveId(null);}}>
              <Icon name="x" size="xs" />
            </button>}
          </div>
        ))}
        {!relevant.length && <p className="muted">No chats for this project yet.</p>}
      </div>
      {active ? (
        <div className="mori-chat-workspace">
          <div className="mori-chat-actions">
            <span className="muted" style={{ fontSize: 12 }}>{status}</span>
            <span className="grow" />
            <button type="button" className="btn sm outline" disabled={checking || !ready} onClick={() => void check()}>Check status</button>
            <button type="button" className="btn sm outline" onClick={() => {
              if (!view.current) return;
              const actual = normalizedChatGPTUrl(view.current.getURL());
              if (actual) patchSessions(list => list.map(item => item.id === active.id ? { ...item, url: actual } : item));
              view.current.loadURL?.("https://chatgpt.com/" );
            }}>ChatGPT home</button>
          </div>
          <div className="mori-chat-webframe">
            {/*
              The webview is only mounted for the active conversation; hidden
              guests consume no renderer memory. Login cookies are shared only
              within Monku's persistent Chromium partition.
            */}
            <webview key={active.id} ref={element => { view.current = element as Guest | null; }}
              src={active.url} partition="persist:mori-chatgpt"
              data-preview-tab={runtimeId}
              style={{ display: "flex", width: "100%", height: "100%" }} />
          </div>
          <div className="mori-chat-compose">
            <div className="mori-chat-context">
              <span>Translation proposals use Codex Luna 6 (low), above. ChatGPT here is for optional manual discussion.</span>
              <span className="grow" />
              <button type="button" className="btn sm outline" onClick={() => go("matrix")}>Go to Matrix</button>
            </div>
            <textarea value={prompt} onChange={event => {setPrompt(event.target.value); setPrepared(null);}}
              aria-label="ChatGPT message" rows={3} placeholder="Ask about this game's terminology, character voice, or translation…" />
            <div className="mori-chat-context">
              <small className="muted">AI text is never copied into the human translation automatically. Inspect replies before capturing.</small>
              <span className="grow" />
              <button type="button" className="btn primary sm" disabled={!ready || sending || !prompt.trim()}
                onClick={() => void sendPrompt()}>{sending ? "Sending…" : "Send to ChatGPT"}</button>
            </div>
          </div>
        </div>
      ) : <div className="mori-chat-empty">
        <h2>Continue your ChatGPT localization chats</h2>
        <p>Start a chat or reopen a hidden tab. Closing a tab here does not delete the ChatGPT conversation.</p>
        <button className="btn primary" onClick={addChat}>Start ChatGPT chat</button>
      </div>}
    </div>
  );
}
