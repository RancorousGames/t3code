import { useEffect, useState } from "react";

type Item = { sourceKey: string; sourceId: string; boardRoot?: string; title: string; body?: string; createdAt?: string };

/** TaskBoard owns decisions and reviews. This is a read-only handoff to its native UI. */
export function TaskBoardInboxItems() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    const reader = window.desktopBridge?.readTaskBoardHumanInbox;
    if (!reader) return;
    let active = true;
    const refresh = () => void reader().then((result) => {
      if (!active) return;
      setItems(result.items);
      setError(result.sources.filter((source) => source.status === "unavailable").map((source) => source.error ?? source.id).join("; "));
    }).catch((cause: unknown) => { if (active) setError(String(cause)); });
    refresh();
    const timer = window.setInterval(refresh, 20_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  if (!window.desktopBridge?.readTaskBoardHumanInbox) return null;
  return <section className="shrink-0 border-b border-border px-3 py-2 text-xs">
    <button type="button" className="w-full text-left font-semibold" onClick={() => setExpanded((value) => !value)}>
      TaskBoard Feedback / Review ({items.length}) {expanded ? "▾" : "▸"}
    </button>
    {expanded && <div className="mt-2 max-h-48 space-y-2 overflow-y-auto">
      {items.map((item) => <div key={item.sourceKey} className="rounded border border-border p-2">
        <p className="font-medium">{item.title}</p>
        <p className="text-muted-foreground">{item.sourceId}</p>
        <button type="button" className="mt-1 underline disabled:opacity-50"
          disabled={!item.boardRoot || !window.desktopBridge?.openTaskBoardHumanItem}
          onClick={() => {
            if (!item.boardRoot) return;
            void window.desktopBridge?.openTaskBoardHumanItem?.({ boardRoot: item.boardRoot, taskId: item.sourceId })
              .then(() => setError(""))
              .catch((cause: unknown) => setError(`Could not open TaskBoard: ${String(cause)}`));
          }}>Open in TaskBoard Feedback / Review</button>
      </div>)}
      {error && <p role="status" className="text-warning">{error}</p>}
    </div>}
  </section>;
}
