# ChatGPT Bootstrap

Bootstrap supplies full path-labelled guidance and a candidate or preassigned T3 ID. It does not identify the calling browser or change an OpenRig seat. T3 registers the assistant's marker. A generated UUID alone is not a routable session. Bootstrap also accepts optional `title="Short descriptive task title"` as an agent-proposed sidebar name.

The editable role-specific instructions are at `C:/Users/crovea/.agents/docs/guidance/chatgpt-bootstrap-personal.md`, `chatgpt-bootstrap-worker.md`, and `chatgpt-bootstrap-manager.md` (same folder). Bootstrap loads exactly one matching editable role file every call, in addition to global and applicable project guidance. Managed `worker` also receives `D:/SSDProjects/Tools/OpenRig/templates/omni-command/agents/omni-command/guidance/worker.md`; `manager` receives `manager-policy.md` and `project-manager.md` from the same OpenRig guidance folder. For a Global Manager call `Bootstrap(role="manager", manager_kind="global")` to select `global-manager.md` instead. Optional worker specializations are `worker_specialty="expert"`, `"qa"` or `"hard-review"` (each adds its matching OpenRig file). OpenRig roles are not inferred from the project name. Edits to the Markdown are read without rebuilding the service once this source version is deployed.

## Manual ChatGPT custom instructions

For manually created ChatGPT chats, the following custom-instruction wording is required. T3 never injects an additional prompt into manual chats:

> Propose a concise title based on the user's request, then call OMCP Tools Bootstrap(role="personal", title="your descriptive title") at the start of a new conversation (or as soon as possible afterward). Read the returned bundle and print [T3_ID:uuid] first, followed on the next line by the returned [T3_TITLE:...] marker before commentary. If this conversation's initial assignment supplies a T3 given_id, instead pass that given_id and the assigned role and project to Bootstrap. Reuse that same preassigned or registered ID for later Bootstrap calls and session operations. Do not generate a replacement ID for a registered conversation. Report missing files; never assume a missing file was read.

## Internal vs public session IDs

Every browser session keeps its internal ID for life: local storage, the preview owner and the Electron guest are keyed by it and are never renamed. The ID agents and users see is the session's public ID (`bootstrapIdentity.publicId`): preassigned by T3 for spawned children, or adopted from the first `[T3_ID:uuid]` marker in an assistant reply for manual and legacy sessions. Until a marker registers, the public ID is the internal ID. The desktop pipe translates public IDs to internal IDs on the way in and back on the way out (`toInternalChatGPTIds` / `toPublicChatGPTIds` in `apps/web/src/chatGPTBootstrapIdentity.ts`), and both forms stay routable. A marker that claims another session's ID, or differs from a preassigned/registered ID, is recorded as a mismatch and changes nothing. `t3_sessions read` returns `bootstrap.lastProbe`, the last scan outcome, for diagnosing a session that does not register.

## Agent-suggested session titles (separate T3-0197 feature)

The agent chooses a descriptive 3–80-character title in its **Bootstrap call**, rather than T3 guessing from the first words of a conversation. Bootstrap returns `[T3_TITLE:<title>]` for the assistant to print immediately after `[T3_ID:<uuid>]`. For **preassigned backend workers**, OMCPT also sends `bootstrap_title` through the existing local T3 named pipe at tool-call time. T3 applies the title to the exact existing `spawnRequestId`-backed browser session with the matching preassigned public ID; no ChatGPT message or DOM scan is needed. The operation never creates, moves, wakes, or sends to a browser guest. It returns `title_delivery=accepted` on successful acknowledgement and `marker_fallback` otherwise, and is isolated from guest delivery queues. For **manually opened sessions**, the assistant markers remain the registration path; an arbitrary reported ID cannot retitle a manual tab. Manual F2/menu renames (`titleSource=user`) always take precedence, and the first accepted Bootstrap title wins. Missing/invalid suggestions leave existing names unchanged. A proposed title is cosmetic display metadata, not identity proof or authorization.

## Managed creation

The existing initial prompt carries the role, known project, assigned ID and explicit parent. Spawn returns the child ID with pending initial delivery. That means the session exists, not that the child received its assignment or replied. List/read exposes the initial delivery and bootstrap status.

A mismatched marker leaves the preassigned ID unchanged. A repeated spawn request is correlated to its original session; an UNKNOWN initial send is never automatically repeated. Preserve the original request ID and reconcile existing receipts.

Reboot retains the T3 session ID and uses the same Bootstrap given_id. Reboot hashing and initial delivery must use identical role/project context. The existing reboot generation and UNKNOWN receipts remain authoritative.
