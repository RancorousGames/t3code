import type { BrowserSession } from "./chatGPTBrowserSessions";
import { chatGPTParentIndex } from "./chatGPTSessionLineage";
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
export interface ChatGPTPermanentProject {
  readonly key: string;
  readonly title: string;
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

/**
 * Offline training labels can help with project grouping, but are global to
 * the build rather than scoped to the current T3 environment. Never revive a
 * parent from that fixture: a similarly copied session ID in another environment
 * is not proof of an agent spawn relationship. Only persisted per-environment
 * parentSessionId metadata (or explicit user attachment) may establish lineage.
 */
export function applyConfirmedChatGPTSessionMetadata(
  sessions: readonly BrowserSession[],
): BrowserSession[] {
  return sessions.map((session) => {
    const confirmed = corrections[session.id];
    if (!confirmed?.project || session.project !== undefined) return session;
    return { ...session, project: confirmed.project };
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

/** Never guess a parent ID from titles or offline training fixtures. */
export function groupChatGPTSessions(
  sessions: readonly BrowserSession[],
  projects: readonly ChatGPTGroupingProject[],
  permanentProjects: readonly ChatGPTPermanentProject[] = [],
): ChatGPTSidebarGroup[] {
  const enriched = applyConfirmedChatGPTSessionMetadata(sessions);
  const nameGroups = discoverNameGroups(enriched, projects);
  const byId = new Map(enriched.map((session) => [session.id, session]));
  const parentById = chatGPTParentIndex(enriched);
  const assignments = new Map<string, Assignment | null>();
  const visiting = new Set<string>();

  const assignOwn = (session: BrowserSession): Assignment | null => {
    const hint = session.project?.trim();
    if (hint?.toLowerCase() === "other") return null;
    // A user-permanent project wins over transient name grouping when the
    // title truly matches. Explicit session.project metadata is never changed.
    const permanentMatch = (text: string) => permanentProjects.find((project) => {
      const parts = tokens(project.title);
      const words = tokens(text);
      return parts.length > 0 && (parts.length > 1
        ? words.some((_, index) => parts.every((word, offset) => words[index + offset] === word))
        : parts[0]!.length >= 4 && words.includes(parts[0]!));
    });
    if (hint) {
      const pinned = permanentProjects.find((project) => readable(project.title).toLowerCase() === readable(hint).toLowerCase());
      if (pinned) return { key: pinned.key, title: pinned.title };
      const project = matchRegisteredProject(hint, projects);
      return project
        ? { key: `project:${project.id}`, title: project.title }
        : { key: `hint:${hint.toLowerCase()}`, title: readable(hint) };
    }
    const pinned = permanentMatch(session.title);
    if (pinned) return { key: pinned.key, title: pinned.title };
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
    const parent = byId.get(parentById.get(session.id) ?? "");
    const parentAssignment = parent ? resolve(parent) : null;
    const own = assignOwn(session);
    // A child follows its real parent, even if it was independently assigned
    // another project during spawn. A hierarchy cannot span two project rows.
    const assignment = parent ? parentAssignment : own;
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
    if (group.sessions.length > 1 || permanentProjects.some((project) => project.key === key)) continue;
    ungrouped.push(...group.sessions);
    groupMap.delete(key);
  }

  const originalOrder = new Map(enriched.map((session, index) => [session.id, index]));
  const flatten = (members: readonly BrowserSession[]): ChatGPTSidebarSession[] => {
    const ids = new Set(members.map((session) => session.id));
    const children = new Map<string, BrowserSession[]>();
    for (const session of members) {
      const parent = parentById.get(session.id);
      if (!parent || !ids.has(parent)) continue;
      const entries = children.get(parent) ?? [];
      entries.push(session);
      children.set(parent, entries);
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
      const parent = parentById.get(session.id);
      if (!parent || !ids.has(parent)) walk(session, 0);
    }
    members.forEach((session) => walk(session, 0)); // Cycles/orphans remain visible.
    return rows;
  };
  // Permanent headers survive even when their last session closes and always
  // precede inferred groups. Persisting them is explicit user intent.
  for (const project of permanentProjects) {
    if (!groupMap.has(project.key)) groupMap.set(project.key, { title: project.title, sessions: [] });
  }
  const ordered = [...groupMap].sort(([a], [b]) =>
    Number(permanentProjects.some((project) => project.key === b)) -
    Number(permanentProjects.some((project) => project.key === a)));
  const groups: ChatGPTSidebarGroup[] = ordered.map(([key, group]) => ({
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
    | "unloaded"
    | "inactive";
  readonly lastWorkingAt: number;
};
export function layoutChatGPTSessions(
  sessions: readonly BrowserSession[],
  projects: readonly ChatGPTGroupingProject[],
  sortMode: ChatGPTSessionSortMode,
  activityById: Readonly<Record<string, ChatGPTSessionSortActivity>>,
  permanentProjects: readonly ChatGPTPermanentProject[] = [],
): ChatGPTSidebarGroup[] {
  if (sortMode === "started") return groupChatGPTSessions(sessions, projects, permanentProjects);
  const rank: Record<ChatGPTSessionSortActivity["age"], number> = {
    working: 0,
    recent: 1,
    inactive: 2,
    unloaded: 2,
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
  const parentById = chatGPTParentIndex(enriched);
  const children = new Map<string, BrowserSession[]>();
  const rootFor = (session: BrowserSession): string => {
    let node = session;
    const seen = new Set([node.id]);
    let parent = parentById.get(node.id);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      node = byId.get(parent)!;
      parent = parentById.get(node.id);
    }
    return node.id;
  };
  const rootBuckets = new Map<string, BrowserSession[]>();
  for (const session of enriched) {
    const rootId = rootFor(session);
    if (!rootBuckets.has(rootId)) rootBuckets.set(rootId, []);
    rootBuckets.get(rootId)!.push(session);
    const parent = parentById.get(session.id);
    if (parent) {
      const list = children.get(parent) ?? [];
      list.push(session);
      children.set(parent, list);
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
        // Working heartbeats must not move the rows while the user reads or clicks.
        // Other statuses retain activity ordering within their status tier.
        (a.priority !== 0 ? b.latest - a.latest : 0) ||
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
    permanentProjects,
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
