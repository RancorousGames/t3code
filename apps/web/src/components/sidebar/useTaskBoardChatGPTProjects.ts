import { useEffect, useRef } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import type { ChatGPTTaskBoardProject } from "../../chatGPTSessionGrouping";

const schema = Schema.Array(Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  prefixes: Schema.Array(Schema.String),
}));

/** Auto-discovered TaskBoard boards are cached per T3 environment and refreshed
 * on focus/periodically. A temporarily unavailable board preserves last known
 * identities; this is not an inferred project-name generator. */
export function useTaskBoardChatGPTProjects(environmentId: string | null) {
  const [boards, setBoards] = useLocalStorage(
    "t3code:chatgpt-browser:taskboard-projects:" + (environmentId ?? "unconnected"),
    [] as ChatGPTTaskBoardProject[],
    schema,
  );
  const setBoardsRef = useRef(setBoards);
  setBoardsRef.current = setBoards;
  const lastSnapshot = useRef<{ json: string; value: readonly ChatGPTTaskBoardProject[] } | null>(null);
  const json = JSON.stringify(boards);
  if (!lastSnapshot.current || lastSnapshot.current.json !== json)
    lastSnapshot.current = { json, value: boards };
  useEffect(() => {
    const read = window.desktopBridge?.readTaskBoardProjects;
    if (!read) return;
    let cancelled = false;
    let reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const catalog = await read();
        if (!cancelled && catalog.length) {
          setBoardsRef.current((current) =>
            JSON.stringify(current) === JSON.stringify(catalog) ? current : [...catalog],
          );
        }
      } catch { /* Keep last known identities if TaskBoard is briefly offline. */ }
      finally { reading = false; }
    };
    const onFocus = () => { if (!document.hidden) void refresh(); };
    void refresh();
    const interval = window.setInterval(onFocus, 5 * 60_000);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [environmentId]);
  return lastSnapshot.current!.value;
}
