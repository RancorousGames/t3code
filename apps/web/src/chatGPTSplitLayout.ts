import { useSyncExternalStore } from "react";
import { randomUUID } from "./lib/utils";

export type SplitNode =
  | { id: string; sessionId: string }
  | { id: string; direction: "row" | "column"; children: [SplitNode, SplitNode] };

const EVENT = "t3:chatgpt-split-layout";
const key = (environmentId: string) => `t3:chatgpt-splits:v1:${environmentId}`;
const primaryKey = (environmentId: string) => `t3:chatgpt-splits-primary:v1:${environmentId}`;
const leaf = (sessionId: string): SplitNode => ({ id: randomUUID(), sessionId });
const isLeaf = (node: SplitNode): node is Extract<SplitNode, { sessionId: string }> =>
  "sessionId" in node;

export function splitSessionIds(node: SplitNode | null): string[] {
  return !node ? [] : isLeaf(node) ? [node.sessionId] :
    node.children.flatMap(splitSessionIds);
}

export function readSplitLayout(environmentId: string): SplitNode | null {
  try {
    const raw = localStorage.getItem(key(environmentId));
    if (!raw) return null;
    const node = JSON.parse(raw) as SplitNode;
    const seen = new Set<string>();
    const valid = (item: SplitNode, depth: number): boolean => {
      if (!item || typeof item.id !== "string" || depth > 100) return false;
      if (isLeaf(item)) {
        if (typeof item.sessionId !== "string" || seen.has(item.sessionId)) return false;
        seen.add(item.sessionId);
        return true;
      }
      return (item.direction === "row" || item.direction === "column") &&
        Array.isArray(item.children) && item.children.length === 2 &&
        item.children.every((child) => valid(child, depth + 1));
    };
    return valid(node, 0) ? node : null;
  } catch {
    return null;
  }
}

function write(environmentId: string, node: SplitNode | null) {
  if (node) localStorage.setItem(key(environmentId), JSON.stringify(node));
  else localStorage.removeItem(key(environmentId));
  window.dispatchEvent(new CustomEvent(EVENT, { detail: environmentId }));
}

export function useSplitLayout(environmentId: string | null | undefined): SplitNode | null {
  const raw = useSyncExternalStore(
    (notify) => {
      const onChange = (event: Event) => {
        if (event.type === "storage" ||
          (event as CustomEvent<string>).detail === environmentId) notify();
      };
      window.addEventListener(EVENT, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        window.removeEventListener(EVENT, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    () => environmentId ? localStorage.getItem(key(environmentId)) : null,
    () => null,
  );
  // Parse after subscription; do not return freshly parsed objects as the external snapshot.
  if (!raw || !environmentId) return null;
  return readSplitLayout(environmentId);
}

export function reconcileSplitLayout(
  environmentId: string,
  available: ReadonlySet<string>,
  selectedId: string,
): SplitNode {
  const prune = (node: SplitNode | null): SplitNode | null => {
    if (!node) return null;
    if (isLeaf(node)) return available.has(node.sessionId) ? node : null;
    const left = prune(node.children[0]);
    const right = prune(node.children[1]);
    return left && right ? { ...node, children: [left, right] } : left ?? right;
  };
  const previous = readSplitLayout(environmentId);
  let node = prune(previous);
  if (!node) node = leaf(selectedId);
  else if (!splitSessionIds(node).includes(selectedId)) {
    const previousPrimary = localStorage.getItem(primaryKey(environmentId));
    node = replaceLeaf(node, previousPrimary && splitSessionIds(node).includes(previousPrimary)
      ? previousPrimary : splitSessionIds(node)[0]!, selectedId);
  }
  if (JSON.stringify(node) !== JSON.stringify(previous)) write(environmentId, node);
  localStorage.setItem(primaryKey(environmentId), selectedId);
  return node;
}

function mapLeaves(node: SplitNode, target: string, update: (leaf: Extract<SplitNode, { sessionId: string }>) => SplitNode): SplitNode {
  if (isLeaf(node)) return node.sessionId === target ? update(node) : node;
  return { ...node, children: node.children.map((child) => mapLeaves(child, target, update)) as [SplitNode, SplitNode] };
}

export function replaceLeaf(node: SplitNode, oldId: string, newId: string): SplitNode {
  if (oldId === newId || splitSessionIds(node).includes(newId)) return node;
  return mapLeaves(node, oldId, (existing) => ({ ...existing, sessionId: newId }));
}

export function splitLeaf(node: SplitNode, target: string, next: string, direction: "row" | "column"): SplitNode {
  if (splitSessionIds(node).includes(next)) return node;
  return mapLeaves(node, target, (existing) => ({
    id: randomUUID(), direction, children: [existing, leaf(next)],
  }));
}

export function closeLeaf(node: SplitNode, target: string): SplitNode | null {
  if (isLeaf(node)) return node.sessionId === target ? null : node;
  const left = closeLeaf(node.children[0], target);
  const right = closeLeaf(node.children[1], target);
  return left && right ? { ...node, children: [left, right] } : left ?? right;
}

export function saveSplitLayout(environmentId: string, node: SplitNode | null) {
  write(environmentId, node);
}

export function visibleSplitSessionIds(environmentId: string): ReadonlySet<string> {
  return new Set(splitSessionIds(readSplitLayout(environmentId)));
}
