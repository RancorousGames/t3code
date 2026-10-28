import type {
  AgentProviderV1HistoryItem,
  AgentProviderV1SessionRef,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { projectTurnItemForWire } from "./orchestration-v2/WireProjection.ts";
import { encodeThreadHistoryCursor } from "./orchestration-v2/threadHistoryPaging.ts";

/** Only a lossless native thread ref can authorize a native operation. */
export function rawNativeThreadId(ref: AgentProviderV1SessionRef): string | null {
  if (ref.provider !== "t3" || !ref.id.startsWith("thread:")) return null;
  const suffix = ref.id.slice("thread:".length);
  try {
    const decoded = decodeURIComponent(suffix);
    return decoded.length > 0 && encodeURIComponent(decoded) === suffix ? decoded : null;
  } catch {
    return null;
  }
}

/** Stable ids let the existing event-sourced command receipt deduplicate retries. */
export function nativeSubmissionIds(digestBytes: Uint8Array) {
  const digest = Array.from(digestBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { commandId: `provider-v1-command:${digest}`, messageId: `provider-v1-message:${digest}` };
}

/**
 * The existing history-store method accepts an exclusive-position cursor.
 * Bootstrap at the logical end without reading the entire projection. The
 * bootstrap token is never exposed; subsequent cursors come from the store.
 */
export function nativeLatestPageCursor(threadId: string, nonce: string): string {
  return encodeThreadHistoryCursor({
    snapshotSequence: 0,
    sourceThreadId: threadId,
    sourceItemId: nonce,
    position: Number.MAX_SAFE_INTEGER,
  });
}

export function nativeTextContent(content: ReadonlyArray<unknown>): string | null {
  if (content.length !== 1) return null;
  const part = content[0];
  if (
    typeof part !== "object" ||
    part === null ||
    !("type" in part) ||
    part.type !== "text" ||
    !("text" in part) ||
    typeof part.text !== "string" ||
    part.text.trim().length === 0
  )
    return null;
  return part.text;
}

export function nativeHistoryItems(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  snapshotSequence: number,
): AgentProviderV1HistoryItem[] {
  return rows.map((row) => {
    const item = projectTurnItemForWire(row.item);
    // The provider envelope is a JSON RPC boundary, unlike the internal
    // Effect DateTime-rich projection. Encode nested turn payloads to JSON
    // values before returning them through the `data: Unknown` wire schema.
    // Otherwise transport serialization rejects an otherwise valid history
    // page with `Expected JSON value at ["value"]["data"]`.
    let wireItem: unknown;
    try { wireItem = Schema.encodeSync(OrchestrationV2TurnItem)(item); }
    catch { wireItem = { type: item.type, warning: "Native turn detail was not JSON-serializable" }; }
    const visibleText = "text" in item && typeof item.text === "string" ? item.text
      : "markdown" in item && typeof item.markdown === "string" ? item.markdown
      : null;
    return {
      id: `turn:${encodeURIComponent(row.sourceThreadId)}:${encodeURIComponent(row.sourceItemId)}`,
      // The actual event-store snapshot watermark, not a synthetic per-row version.
      revision: snapshotSequence,
      kind: item.type,
      at: DateTime.formatIso(item.updatedAt),
      author:
        item.type === "user_message"
          ? "user"
          : item.type === "assistant_message"
            ? "assistant"
            : "native",
      parts: [
        ...(visibleText !== null ? [{ type: "text", text: visibleText }] : []),
        {
          type: "native.turn_item",
          sourceThreadId: row.sourceThreadId,
          sourceItemId: row.sourceItemId,
          visibility: row.visibility,
          item: wireItem,
        },
      ],
      streaming: "streaming" in item && item.streaming === true,
      completeness: "streaming" in item && item.streaming === true ? "Partial" : "Full",
    };
  });
}
