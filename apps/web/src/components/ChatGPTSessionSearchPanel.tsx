import type { EnvironmentId } from "@t3tools/contracts";
import { SearchIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BrowserSession } from "../chatGPTBrowserSessions";
import { searchChatGPTTranscript } from "../state/chatGPTTranscriptIndex";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useBrowserDefaults } from "../browser/browserDefaults";

export type ChatGPTSessionSearchHit = {
  conversationId: string;
  url: string;
  sessionId: string;
  title: string | null;
  project: string | null;
  role: "user" | "assistant";
  snippet: string;
  turnIndex: number;
  observedAt: string;
  firstTurnMissing: boolean;
};

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const at = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark className="rounded bg-primary/15 text-foreground">{text.slice(at, at + needle.length)}</mark>{text.slice(at + needle.length)}</>;
}

/** The backend index owns the results. No browser guest is woken by searching. */
export function ChatGPTSessionSearchPanel({
  environmentId,
  sessions,
  onClose,
  onChoose,
  initialQuery = "",
}: {
  environmentId: EnvironmentId;
  sessions: readonly BrowserSession[];
  onClose: () => void;
  onChoose: (hit: ChatGPTSessionSearchHit) => Promise<void>;
  initialQuery?: string;
}) {
  const search = useAtomCommand(searchChatGPTTranscript, { reportFailure: false });
  const profileId = useBrowserDefaults().profileId;
  const [historyHits, setHistoryHits] = useState<readonly {
    conversationId: string; url: string; title: string;
  }[]>([]);
  const [historySearched, setHistorySearched] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [query, setQuery] = useState(initialQuery);
  const [role, setRole] = useState<"both" | "user" | "assistant">("both");
  const [project, setProject] = useState("all");
  const [since, setSince] = useState("any");
  const [hits, setHits] = useState<readonly ChatGPTSessionSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const term = query.trim();
  const searchOwnHistory = async () => {
    if (term.length < 2 || historyBusy) return;
    const historySearch = window.desktopBridge?.searchChatGPTHistory;
    if (!historySearch) {
      setHistoryError("ChatGPT history search is unavailable in this T3 build.");
      return;
    }
    setHistoryBusy(true);
    setHistoryError(null);
    setHistoryHits([]);
    setHistorySearched(null);
    try {
      const results = await historySearch({ environmentId, profileId, query: term });
      setHistoryHits(results);
      setHistorySearched(term);
    } catch {
      // The DOM may change without notice. Never show guesses, or claim zero
      // results when the native utility failed to inspect search reliably.
      setHistoryError("ChatGPT history search unavailable. Use Browser view to search ChatGPT directly.");
    } finally {
      setHistoryBusy(false);
    }
  };
  const projects = useMemo(() => [...new Set(sessions.map((session) => session.project)
    .filter((name): name is string => typeof name === "string" && name.length > 0))]
    .sort((a, b) => a.localeCompare(b)), [sessions]);
  useEffect(() => { if (initialQuery) setQuery(initialQuery); }, [initialQuery]);
  useEffect(() => {
    if (term.length < 2) { setHits([]); setError(null); setBusy(false); return; }
    let cancelled = false;
    setBusy(true);
    const timer = window.setTimeout(() => {
      void search({ environmentId, input: {
        query: term, limit: 80, ...(role === "both" ? {} : { role }),
        ...(project === "all" ? {} : { project }),
      } }).then((result) => {
        if (cancelled) return;
        if (result._tag === "Success") { setHits(result.value); setError(null); }
        else { setHits([]); setError("Message index unavailable. Search cannot inspect unloaded conversations yet."); }
      }).catch((cause: unknown) => {
        if (!cancelled) { setHits([]); setError(String(cause)); }
      }).finally(() => { if (!cancelled) setBusy(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [environmentId, role, project, term, search]);

  const local = useMemo(() => term.length >= 2 ? sessions.filter((session) =>
    (project === "all" || project === session.project) &&
    [session.title, session.id, session.project ?? "", session.binding?.taskRef?.id ?? ""]
      .some((field) => field.toLocaleLowerCase().includes(term.toLocaleLowerCase())),
  ).slice(0, 12) : [], [sessions, term, project]);
  const byId = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const after = since === "any" ? null : Date.now() - Number(since) * 24 * 60 * 60_000;
  const filteredHits = useMemo(() => hits.filter((hit) =>
    after === null || (Number.isFinite(Date.parse(hit.observedAt)) &&
      Date.parse(hit.observedAt) >= after)), [hits, after]);
  const groups = useMemo(() => {
    const grouped = new Map<string, ChatGPTSessionSearchHit[]>();
    for (const hit of filteredHits) {
      const list = grouped.get(hit.conversationId) ?? [];
      list.push(hit);
      grouped.set(hit.conversationId, list);
    }
    return [...grouped.values()];
  }, [filteredHits]);
  const groupedHits = useMemo(() => groups.flat(), [groups]);
  return (
    <section className="shrink-0 border-b border-border bg-background px-5 py-3" aria-label="Search ChatGPT messages">
      <div className="flex items-center gap-2">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <Input autoFocus aria-label="Search titles and message text" placeholder="Search all observed conversations…"
          value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="Search role" value={role} onChange={(event) =>
          setRole(event.target.value as typeof role)} className="rounded border border-border bg-background px-2 py-1 text-xs">
          <option value="both">Everyone</option><option value="user">You</option><option value="assistant">ChatGPT</option>
        </select>
        <Button size="xs" variant="ghost" onClick={onClose}><XIcon className="size-4" /><span className="sr-only">Close search</span></Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <label className="inline-flex items-center gap-1.5">Project
          <select aria-label="Search project" value={project} onChange={(event) => setProject(event.target.value)}
            className="h-7 max-w-48 rounded border border-border bg-background px-2 text-xs">
            <option value="all">All projects</option>
            {projects.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5">When
          <select aria-label="Search time range" value={since} onChange={(event) => setSince(event.target.value)}
            className="h-7 rounded border border-border bg-background px-2 text-xs">
            <option value="any">Any time</option>
            <option value="1">Last day</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>
        <span className="text-muted-foreground">Includes hidden and closed conversations indexed by T3</span>
      </div>
      {term.length >= 2 && <div className="mt-2 max-h-72 space-y-3 overflow-y-auto">
        {local.length > 0 && <div>
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Sessions</p>
          {local.map((session) => <button type="button" key={session.id}
            className="block w-full rounded p-2 text-left text-sm hover:bg-muted/60"
            onClick={() => {
              setError(null);
              void onChoose({ conversationId: "", url: "", sessionId: session.id,
                title: session.title, project: session.project ?? null, role: "user", snippet: "", turnIndex: -1,
                observedAt: "", firstTurnMissing: false }).catch((cause: unknown) =>
                setError(`Could not open session: ${String(cause)}`));
            }}>
            <span className="font-medium"><Highlight text={session.title} query={term} /></span>
            <span className="ml-2 text-xs text-muted-foreground">{session.hidden ? "Hidden" : "Session"}</span>
          </button>)}
        </div>}
        <div>
          <p className="mb-1 text-xs font-semibold text-muted-foreground">Messages {busy ? "· searching…" : `· ${filteredHits.length} matches in ${groups.length} conversations`}</p>
          {error && <p role="status" className="py-2 text-xs text-muted-foreground">{error}</p>}
          {groupedHits.map((hit, i) => {
            const owner = byId.get(hit.sessionId);
            const label = owner?.title ?? hit.title ?? "Saved conversation";
            const state = owner ? owner.hidden ? "Hidden" : "Session" : "Saved / closed";
            return <div key={`${hit.conversationId}:${hit.turnIndex}:${i}`}>
              {(i === 0 || groupedHits[i - 1]?.conversationId !== hit.conversationId) &&
                <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/70 py-1.5">
                  <span className="min-w-0 truncate text-xs font-semibold" title={label}>{label}</span>
                  <span className="shrink-0 rounded border border-border px-1.5 text-2xs text-muted-foreground">{state}</span>
                </div>}
              <button type="button"
              disabled={opening !== null}
              className="mb-1 block w-full rounded border border-border/60 p-2 text-left hover:bg-muted/60 disabled:opacity-50"
              onClick={() => {
                setOpening(`${i}`); setError(null);
                void onChoose(hit).catch((cause: unknown) => setError(`Could not open this result: ${String(cause)}`))
                  .finally(() => setOpening(null));
              }}>
              <span className="block text-xs font-medium">{label} · {hit.role === "user" ? "You" : "ChatGPT"} · turn {hit.turnIndex}</span>
              <span className="mt-1 block line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground"><Highlight text={hit.snippet} query={term} /></span>
              {hit.firstTurnMissing && <span className="text-xs text-muted-foreground">Partial history</span>}
              </button>
            </div>;
          })}
          {!busy && !error && filteredHits.length === 0 && <p className="text-xs text-muted-foreground">No indexed message matches.</p>}
        </div>
        <div className="border-t border-border/70 pt-2">
          <Button size="xs" type="button" variant="outline"
            disabled={historyBusy}
            onClick={() => void searchOwnHistory()}>
            {historyBusy ? "Searching ChatGPT..." : `Search ChatGPT history for ${term}`}
          </Button>
          {historyError && <p role="status" className="mt-2 text-xs text-muted-foreground">
            {historyError}</p>}
          {historySearched === term && <div className="mt-2 space-y-1">
            <p className="text-xs font-semibold text-muted-foreground">
              From ChatGPT history : {historyHits.length} results
            </p>
            {historyHits.length === 0 && <p className="text-xs text-muted-foreground">
              No results reported by ChatGPT search.</p>}
            {historyHits.map((hit) => <button key={hit.conversationId} type="button"
              className="block w-full rounded border border-border/60 p-2 text-left text-xs hover:bg-muted/60"
              disabled={opening !== null} onClick={() => {
                setOpening(hit.conversationId);
                void onChoose({
                  ...hit, sessionId: "", role: "user", project: null,
                  snippet: "", turnIndex: -1, observedAt: "", firstTurnMissing: true,
                }).catch((cause: unknown) =>
                  setHistoryError(`Could not open ChatGPT history result: ${String(cause)}`))
                  .finally(() => setOpening(null));
              }}>{hit.title}</button>)}
          </div>}
        </div>
      </div>}
      {term.length < 2 && <p className="mt-2 text-xs text-muted-foreground">Find a session by title, or search messages already observed by T3. Hidden sessions are included.</p>}
    </section>
  );
}
