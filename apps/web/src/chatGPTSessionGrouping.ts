import type { BrowserSession } from "./chatGPTBrowserSessions";
import learned from "./chatGPTGroupingTraining.generated.json";

export interface ChatGPTGroupingProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}
export interface ChatGPTSidebarSession {
  readonly session: BrowserSession;
  readonly depth: number;
  readonly childCount: number;
}
export interface ChatGPTSidebarGroup {
  readonly key: string | null;
  readonly title: string | null;
  readonly rows: readonly ChatGPTSidebarSession[];
}

type Assignment = { key: string; title: string };

const readable = (value: string): string =>
  value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_./\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tokens = (value: string): string[] =>
  readable(value)
    .toLowerCase()
    .match(/[a-z\d]{3,}/g) ?? [];
const basename = (value: string): string =>
  value
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? "";
const pathKey = (value: string): string =>
  value.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");

type LearnedWorkspace = Readonly<Record<string, number>>;
const vocabularies = learned.vocabularyByWorkspace as Readonly<Record<string, LearnedWorkspace>>;
const corrections = learned.confirmedSessionMetadata as Readonly<
  Record<string, { readonly project?: string; readonly parentSessionId?: string }>
>;
const labeledExamples = learned.training as ReadonlyArray<{
  readonly title: string;
  readonly project: string;
}>;

/** User-verified, exact-session metadata is applied only when not already set.
 * This does not mutate Chromium storage or affect any unrelated session. */
export function applyConfirmedChatGPTSessionMetadata(
  sessions: readonly BrowserSession[],
): BrowserSession[] {
  return sessions.map((session) => {
    const confirmed = corrections[session.id];
    if (!confirmed) return session;
    const parentSessionId = session.parentSessionId ?? confirmed.parentSessionId;
    const project = session.project ?? confirmed.project;
    return parentSessionId === session.parentSessionId && project === session.project
      ? session
      : {
          ...session,
          ...(parentSessionId ? { parentSessionId } : {}),
          ...(project ? { project } : {}),
        };
  });
}

function nameScore(text: string, project: ChatGPTGroupingProject): number {
  const words = tokens(text);
  if (words.length === 0) return 0;
  const wordSet = new Set(words);
  let best = 0;
  for (const name of new Set([project.title, basename(project.workspaceRoot)])) {
    const parts = tokens(name);
    if (!parts.length) continue;
    if (
      parts.length > 1 &&
      words.some((_, index) => parts.every((word, offset) => words[index + offset] === word))
    ) {
      best = Math.max(best, 40 + parts.length);
    } else if (
      parts.length === 1 &&
      wordSet.has(parts[0]!) &&
      (parts[0]!.length >= 5 || words.length === 1)
    ) {
      // A generic worktree name like "main" cannot claim "GRAPPLE MAIN".
      best = Math.max(best, 32);
    } else if (parts.length > 1 && parts.every((word) => wordSet.has(word))) {
      best = Math.max(best, 28);
    } else if (parts.length > 1 && parts.some((word) => word.length >= 5 && wordSet.has(word))) {
      best = Math.max(best, 15);
    }
  }
  return best;
}

/** The model learns filename frequency and per-project document frequency;
 * there is no curated game/tool-specific keyword dictionary. */
function registeredScores(text: string, projects: readonly ChatGPTGroupingProject[]) {
  const words = new Set(tokens(text));
  const documentFrequency = new Map<string, number>();
  for (const project of projects) {
    const vocab = vocabularies[pathKey(project.workspaceRoot)] ?? {};
    for (const token of Object.keys(vocab)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return projects
    .map((project) => {
      const vocab = vocabularies[pathKey(project.workspaceRoot)] ?? {};
      let score = nameScore(text, project);
      for (const word of words) {
        const count = vocab[word] ?? 0;
        if (count < 4 || word.length < 4) continue;
        const idf = Math.log(1 + (projects.length + 1) / (1 + (documentFrequency.get(word) ?? 0)));
        score += Math.min(5, Math.max(0, Math.log1p(count) - Math.log(10))) * idf * 1.5;
      }
      // Transfer feedback to related titles via overlap, not fixed special-case
      // rules. A verified label always takes priority for its exact session ID.
      for (const example of labeledExamples) {
        if (example.project.toLowerCase() !== project.title.toLowerCase()) continue;
        const reference = new Set(tokens(example.title));
        if (!reference.size) continue;
        const overlap = [...words].filter((word) => reference.has(word)).length;
        if (overlap) {
          const similarity = overlap / Math.max(words.size, reference.size);
          score += 12 * similarity * similarity;
        }
      }
      return { project, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function matchRegisteredProject(
  text: string,
  projects: readonly ChatGPTGroupingProject[],
): ChatGPTGroupingProject | null {
  const ranked = registeredScores(text, projects);
  if (!ranked.length || ranked[0]!.score < 4) return null;
  const best = ranked[0]!;
  const runnerUp = ranked[1]?.score ?? 0;
  if (best.score - runnerUp < (best.score < 20 ? 3 : 5)) return null;
  return best.project;
}

function discoverNameGroups(
  sessions: readonly BrowserSession[],
  projects: readonly ChatGPTGroupingProject[],
): Map<string, { title: string; ids: Set<string> }> {
  const projectWords = new Set(
    projects.flatMap((project) => [project.title, basename(project.workspaceRoot)].flatMap(tokens)),
  );
  const frequency = new Map<string, Set<string>>();
  const properNames = new Map<string, Set<string>>();
  const spelling = new Map<string, string>();
  for (const session of sessions) {
    const title = session.title;
    for (const match of title.matchAll(/\b[A-Za-z][A-Za-z0-9]{3,}\b/g)) {
      const raw = match[0],
        word = raw.toLowerCase();
      if (projectWords.has(word)) continue;
      if (!frequency.has(word)) frequency.set(word, new Set());
      frequency.get(word)!.add(session.id);
      const looksLikeName =
        /^[A-Z]/.test(raw) && (/^[A-Z][a-z]/.test(raw) || (raw.length >= 7 && match.index === 0));
      if (looksLikeName) {
        if (!properNames.has(word)) properNames.set(word, new Set());
        properNames.get(word)!.add(session.id);
        spelling.set(word, raw);
      }
    }
  }
  const groups = new Map<string, { title: string; ids: Set<string> }>();
  for (const [word, ids] of frequency) {
    if (ids.size < 2 || (properNames.get(word)?.size ?? 0) < 2) continue;
    groups.set(word, { title: spelling.get(word) ?? word, ids });
  }
  return groups;
}

/** Never guess a parent ID from similar titles. Verified exact relationships
 * from the review fixture and explicitly supplied metadata are respected. */
export function groupChatGPTSessions(
  sessions: readonly BrowserSession[],
  projects: readonly ChatGPTGroupingProject[],
): ChatGPTSidebarGroup[] {
  const enriched = applyConfirmedChatGPTSessionMetadata(sessions);
  const nameGroups = discoverNameGroups(enriched, projects);
  const byId = new Map(enriched.map((session) => [session.id, session]));
  const assignments = new Map<string, Assignment | null>();
  const visiting = new Set<string>();

  const assignOwn = (session: BrowserSession): Assignment | null => {
    const hint = session.project?.trim();
    if (hint?.toLowerCase() === "other") return null;
    if (hint) {
      const project = matchRegisteredProject(hint, projects);
      return project
        ? { key: `project:${project.id}`, title: project.title }
        : { key: `hint:${hint.toLowerCase()}`, title: readable(hint) };
    }
    const direct = matchRegisteredProject(session.title, projects);
    const strong = direct && nameScore(session.title, direct) >= 20;
    const name = [...nameGroups].find(([, candidate]) => candidate.ids.has(session.id));
    if (name && !strong) return { key: `name:${name[0]}`, title: name[1].title };
    if (direct) return { key: `project:${direct.id}`, title: direct.title };
    return name ? { key: `name:${name[0]}`, title: name[1].title } : null;
  };
  const resolve = (session: BrowserSession): Assignment | null => {
    if (assignments.has(session.id)) return assignments.get(session.id) ?? null;
    if (visiting.has(session.id)) return null;
    visiting.add(session.id);
    const parent = session.parentSessionId && byId.get(session.parentSessionId);
    const parentAssignment = parent && parent.id !== session.id ? resolve(parent) : null;
    const own = assignOwn(session);
    // A child follows its real parent, even if it was independently assigned
    // another project during spawn. A hierarchy cannot span two project rows.
    const assignment = parent && parent.id !== session.id ? parentAssignment : own;
    visiting.delete(session.id);
    assignments.set(session.id, assignment ?? null);
    return assignment ?? null;
  };
  enriched.forEach(resolve);

  const groupMap = new Map<string, { title: string; sessions: BrowserSession[] }>();
  const ungrouped: BrowserSession[] = [];
  for (const session of enriched) {
    const assignment = assignments.get(session.id);
    if (!assignment) {
      ungrouped.push(session);
      continue;
    }
    if (!groupMap.has(assignment.key))
      groupMap.set(assignment.key, { title: assignment.title, sessions: [] });
    groupMap.get(assignment.key)!.sessions.push(session);
  }
  // A single session does not need a project header.
  for (const [key, group] of groupMap) {
    if (group.sessions.length > 1) continue;
    ungrouped.push(...group.sessions);
    groupMap.delete(key);
  }

  const originalOrder = new Map(enriched.map((session, index) => [session.id, index]));
  const flatten = (members: readonly BrowserSession[]): ChatGPTSidebarSession[] => {
    const ids = new Set(members.map((session) => session.id));
    const children = new Map<string, BrowserSession[]>();
    for (const session of members) {
      if (
        !session.parentSessionId ||
        session.parentSessionId === session.id ||
        !ids.has(session.parentSessionId)
      )
        continue;
      const entries = children.get(session.parentSessionId) ?? [];
      entries.push(session);
      children.set(session.parentSessionId, entries);
    }
    const rows: ChatGPTSidebarSession[] = [];
    const seen = new Set<string>();
    const walk = (session: BrowserSession, depth: number) => {
      if (seen.has(session.id)) return;
      seen.add(session.id);
      rows.push({ session, depth, childCount: children.get(session.id)?.length ?? 0 });
      for (const child of children.get(session.id) ?? []) walk(child, depth + 1);
    };
    for (const session of members) {
      if (
        !session.parentSessionId ||
        session.parentSessionId === session.id ||
        !ids.has(session.parentSessionId)
      )
        walk(session, 0);
    }
    members.forEach((session) => walk(session, 0)); // Cycles/orphans remain visible.
    return rows;
  };
  const groups: ChatGPTSidebarGroup[] = [...groupMap].map(([key, group]) => ({
    key,
    title: group.title,
    rows: flatten(group.sessions),
  }));
  if (ungrouped.length) {
    ungrouped.sort((a, b) => originalOrder.get(a.id)! - originalOrder.get(b.id)!);
    groups.push({ key: "other", title: "Other", rows: flatten(ungrouped) });
  }
  return groups;
}

export type ChatGPTSessionSortMode = "started" | "activity";
export type ChatGPTSessionSortActivity = {
  readonly age:
    | "working"
    | "recent"
    | "interrupted"
    | "delivery-timeout"
    | "invalid"
    | "unknown"
    | "inactive";
  readonly lastWorkingAt: number;
};
export function layoutChatGPTSessions(
  sessions: readonly BrowserSession[],
  projects: readonly ChatGPTGroupingProject[],
  sortMode: ChatGPTSessionSortMode,
  activityById: Readonly<Record<string, ChatGPTSessionSortActivity>>,
): ChatGPTSidebarGroup[] {
  if (sortMode === "started") return groupChatGPTSessions(sessions, projects);
  const rank: Record<ChatGPTSessionSortActivity["age"], number> = {
    working: 0,
    recent: 1,
    inactive: 2,
    unknown: 2,
    interrupted: 3,
    "delivery-timeout": 3,
    invalid: 4,
  };
  const order = new Map(sessions.map((session, index) => [session.id, index]));
  // Keep parent/child subtrees together across status boundaries. The
  // previous flat "active" queue always erased indentation.
  const enriched = applyConfirmedChatGPTSessionMetadata(sessions);
  const byId = new Map(enriched.map((session) => [session.id, session]));
  const children = new Map<string, BrowserSession[]>();
  const rootFor = (session: BrowserSession): string => {
    let node = session;
    const seen = new Set([node.id]);
    while (
      node.parentSessionId &&
      byId.has(node.parentSessionId) &&
      !seen.has(node.parentSessionId)
    ) {
      seen.add(node.parentSessionId);
      node = byId.get(node.parentSessionId)!;
    }
    return node.id;
  };
  const rootBuckets = new Map<string, BrowserSession[]>();
  for (const session of enriched) {
    const rootId = rootFor(session);
    if (!rootBuckets.has(rootId)) rootBuckets.set(rootId, []);
    rootBuckets.get(rootId)!.push(session);
    if (
      session.parentSessionId &&
      byId.has(session.parentSessionId) &&
      session.parentSessionId !== session.id
    ) {
      const list = children.get(session.parentSessionId) ?? [];
      list.push(session);
      children.set(session.parentSessionId, list);
    }
  }
  const buckets = [...rootBuckets]
    .map(([rootId, members]) => {
      const priority = Math.min(
        ...members.map((session) => rank[activityById[session.id]?.age ?? "unknown"]),
      );
      const latest = Math.max(
        0,
        ...members.map((session) => activityById[session.id]?.lastWorkingAt ?? 0),
      );
      return { rootId, members, priority, latest };
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.priority <= 1 ? b.latest - a.latest : 0) ||
        (order.get(a.rootId) ?? 0) - (order.get(b.rootId) ?? 0),
    );
  const emitTree = (bucket: (typeof buckets)[number]): ChatGPTSidebarSession[] => {
    const rows: ChatGPTSidebarSession[] = [];
    const seen = new Set<string>();
    const members = new Set(bucket.members.map((session) => session.id));
    const walk = (session: BrowserSession, depth: number) => {
      if (seen.has(session.id)) return;
      seen.add(session.id);
      const descendants = (children.get(session.id) ?? []).filter(
        (child) => members.has(child.id) && !seen.has(child.id),
      );
      rows.push({ session, depth, childCount: descendants.length });
      descendants.forEach((child) => walk(child, depth + 1));
    };
    walk(byId.get(bucket.rootId) ?? bucket.members[0]!, 0);
    bucket.members.forEach((session) => walk(session, 0));
    return rows;
  };
  const priorityGroups: ChatGPTSidebarGroup[] = [];
  const active = buckets.filter((bucket) => bucket.priority <= 1);
  if (active.length)
    priorityGroups.push({
      key: "status:active",
      title: null,
      rows: active.flatMap(emitTree),
    });
  // Idle sessions retain project headings. Errors are always *below* idle.
  const idle = buckets.filter((bucket) => bucket.priority === 2);
  const idleGroups = groupChatGPTSessions(
    idle.flatMap((bucket) => bucket.members),
    projects,
  );
  priorityGroups.push(...idleGroups);
  const errors = buckets.filter((bucket) => bucket.priority >= 3);
  if (errors.length)
    priorityGroups.push({
      key: "status:errors",
      title: "Errors",
      rows: errors.flatMap(emitTree),
    });
  return priorityGroups;
}
