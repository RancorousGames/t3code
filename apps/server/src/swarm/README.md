# Swarm vertical slice (T3-0285)

An **opt-in, local, source-only shared board** for existing native T3 threads and ChatGPT browser sessions. The desktop sidebar has its own **Swarms** workspace (coordinator, members, board and delivery status); the CLI exposes the same persisted board to agents with shell access. Everything substantive is under `apps/server/src/swarm/` and `apps/web/src/components/swarm/`. Integration is a single authenticated HTTP route registration, one sidebar component mount, and the removable `scripts/swarm.mjs` CLI. No startup hooks, migrations, Caffy scheduler, new browser sender, or Orchestrator V2 modifications.

## Desktop sidebar workflow

After a separately authorized desktop update/restart, expand **Swarms** in the existing sidebar and select **New swarm**. Choose a name/coordinator, opt in with **Enable changes**, and create the board. Add one **native T3 thread** participant (its existing thread ID and optional environment ID) and one **ChatGPT browser** participant (exact T3 session ID **and** ChatGPT conversation ID); the UI never spawns either. Post a board entry using `@alias` to wake participants, or provide explicit comma-separated aliases. Use **Detach** to remove a member without closing its underlying session, then reattach the alias if a conversation was rebooted. Press **Deliveries** to check T3's receipt. Selecting the swarm from the sidebar reopens the same shared board, while ordinary chats retain their existing navigation. Disabling writes closes only the Swarm mutation path for this workspace instance; no background watches, autoreplies or hidden workers are created.

The sidebar uses a browser-cookie-authenticated `POST /api/swarm` route, with existing read/operate scopes. The server reuses its **already present** desktop named-pipe transport for native sends and ChatGPT's desktop durable delivery ledger; the CLI uses T3's existing standalone pipe clients. Data lives under `<T3 baseDir>/swarm` for server-backed Swarm, which is `.t3/swarm` for the default development checkout. When the server has a different T3 base directory, set `T3_SWARM_HOME=<that baseDir>/swarm` on CLI invocations to access the _same_ workspace. Swarm remains source-only until installed/restarted with user permission.

## Run (CLI)

PowerShell examples below assume `D:\\SSDProjects\\Tools\\t3code` as current directory. Pass one JSON object on **stdin** per invocation (not as a command-line argument). Only writes/wakes require `--enable`. No background jobs are started by this command.

```powershell
'{"action":"create","name":"Cross-runtime feature demo"}' | node scripts/swarm.mjs --enable
'{"action":"list"}' | node scripts/swarm.mjs
```

Copy the returned **swarm UUID** as `SWARM_ID` in the following requests. First locate an **existing**, already-authorized native thread and ChatGPT browser session with:

```powershell
'{"action":"list"}' | node scripts/t3-native-threads.mjs
'{"action":"list","which":"all","includeHidden":true}' | node scripts/chatgpt-sessions.mjs
```

Attach one of each kind. Use the actual IDs from these read-only inventories. A native UUID thread ID is sufficient, while an opaque MCP thread ID also requires the exact environment ID from its desktop inventory. For ChatGPT, record **both** the T3 session ID and the exact `/c/<UUID>` conversation ID; they are not interchangeable.

```powershell
'{"action":"attach","swarmId":"SWARM_ID","member":"native","kind":"native","threadId":"NATIVE_THREAD_ID","environmentId":"ENVIRONMENT_ID"}' | node scripts/swarm.mjs --enable
'{"action":"attach","swarmId":"SWARM_ID","member":"browser","kind":"chatgpt","sessionId":"T3_SESSION_UUID","conversationId":"CHATGPT_CONVERSATION_UUID"}' | node scripts/swarm.mjs --enable
```

Ordinary posts create append-only board messages. Native agents with PC shell access can use this CLI; ChatGPT agents use OMCP-T `t3_sessions` with `action:"swarm"` and `params.action:"post"/"read"` instead. Both must post under an attached alias. Neither runtime is spawned automatically:

```powershell
'{"action":"post","swarmId":"SWARM_ID","author":"native","body":"Native participant reporting in."}' | node scripts/swarm.mjs --enable
'{"action":"post","swarmId":"SWARM_ID","author":"browser","body":"ChatGPT participant reporting in."}' | node scripts/swarm.mjs --enable
'{"action":"read","swarmId":"SWARM_ID"}' | node scripts/swarm.mjs
```

**Wake-on-mention**: `@native` or `@browser` in the message body automatically wakes that attached alias. An optional `mentions` array overrides automatic extraction; supply `[]` explicitly to suppress notifications (for example when quoting another message). Unrecognised aliases do not wake anyone. All wakes go through the existing T3 delivery transports, not a separate scheduler. Use a caller-stable `messageId` for retry safety.

```powershell
'{"action":"post","swarmId":"SWARM_ID","author":"human","body":"@native @browser: compare your approaches on this board.","messageId":"CALLER_STABLE_UUID"}' | node scripts/swarm.mjs --enable
'{"action":"delivery","swarmId":"SWARM_ID"}' | node scripts/swarm.mjs
```

For a later explicit wake of an existing post, use `{"action":"wake","swarmId":"...","messageId":"...","member":"browser"}` with `--enable`. Re-posting the **same** `messageId` with the **same** content is idempotent; changing content under an existing ID is rejected. To replay an event safely after a lost CLI reply, use the same caller-stable message UUID.

Agents can fetch only new board messages without rereading the entire conversation:

```powershell
'{"action":"read","swarmId":"SWARM_ID","afterMessageId":"LAST_SEEN_UUID","limit":50,"includeWakes":false}' | node scripts/swarm.mjs
'{"action":"detach","swarmId":"SWARM_ID","member":"browser"}' | node scripts/swarm.mjs --enable
```

The response gives `nextAfterMessageId`, `hasMore`, and `totalMessages`. Keep passing the returned cursor until `hasMore` is false. Do not supply an invented or deleted cursor. `detach` leaves the underlying T3 or ChatGPT conversation untouched and allows reattachment to a new session binding. On ChatGPT, use `t3_sessions(action="swarm", params={action:"read", swarmId, afterMessageId, includeWakes:false})` and `params.action="post"` with an attached alias, stable `messageId`, `body`, and `enabled:true`.

## Persistence and delivery semantics

- Append-only immutable event files: `<T3 baseDir>/swarm/<swarm-uuid>/events/*.json` for server-backed Swarm; the source CLI defaults to repo `.t3/swarm` or `T3_SWARM_HOME`. An atomic hard-link publication prevents overwrites and half-written event reads, including concurrent local CLI calls.
- Each message and membership change is an immutable event; aliases can be detached/rebound without erasing history. Wake intents pin the intended original recipient so reattaching an alias cannot redirect an old notification. Records retain a deterministic transport UUID, attempt and outcome. Reading `delivery` consults the **existing** desktop-owned ChatGPT delivery ledger on demand; it does not create another ledger.
- Native explicit wake goes through `controlNativeThreads({action:"send",clientRequestId})` (existing desktop named pipe and thread orchestration). A native acceptance means T3 acknowledged the message ID; it does **not** prove the model replied.
- ChatGPT explicit wake goes through `controlSessions({action:"enqueue",messageId,expectedConversationId})`; the desktop-owned durable queue handles send scheduling, retries and reconciliation. `queued` is not `delivered`, and `delivered` does not imply completed work.
- An attempt is persisted **before** invoking either transport. After timeout/crash/unknown acknowledgement the event is **uncertain**, not automatically re-sent. Inspect the original T3 delivery status or native thread history first. The feature never runs its own retry loop or wakes unloaded sessions on a timer.
- Nothing starts automatically; `--enable` / `T3_SWARM_ENABLED=1` is required for every mutation. Browser requests always write as the human operator; OMCP-T rejects agents claiming `author:"human"`. **Member aliases from the CLI/OMCP-T are not yet cryptographically tied to the invoking agent identity**; do not treat them as an audit-grade principal. Disabling Swarm does not change existing T3 sessions. Removal: delete the feature directory, sidebar component, two integration hooks and `scripts/swarm.mjs`; optionally archive the independent Swarm data.

## Known slice gaps

No mobile-specific workspace UX, automatic native/ChatGPT identity picker, autonomous coordinator/member spawning, automatic transcript-to-board mirroring, reply/turn completion verification, cryptographic member attribution in OMCP-T, fine-grained per-swarm permissions beyond T3 read/operate scopes, or scheduler. A ChatGPT participant requires the upgraded OMCP-T `t3_sessions.swarm` action to append from ChatGPT; native agents need the CLI or an equivalent MCP tool. Neither deployment has been performed on the live services. The two-participant delivery example was exercised against transport stubs; active native/ChatGPT agents were not sent test messages or claimed to have responded. This slice demonstrates shared state and both dispatch paths through injected transport stubs, **not** fully autonomous multi-agent conversation. The newly added HTTP/React integration is source-only and unexercised in the running T3 desktop (no restart was authorized); deployment requires a later authorized update/restart. Existing broad server/web typechecks have unrelated upstream errors; focused Swarm file diagnostics produced no new errors.

## Architecture review (2026-11-20)

**Implemented and checked in this review:** implicit `@alias` mentions, incremental board reads by stable message cursor, detach/rebind of existing participants, recipient-pinned wake intents, idempotent message replay after membership changes, pending (rather than falsely uncertain) delivery when no transport exists, stable create IDs in the sidebar, and human-attributed browser posts. See `index.test.mjs` for focused no-desktop cases.

**Next integration priorities (not delivered by this slice):**

1. **Autonomous coordinator:** use the existing Orchestrator V2/ChatGPT delegation mechanisms to create or attach workers, set worker limits, and assign a concrete objective. Do not invent another browser sender or retry queue.
2. **Native agent MCP capability and identity:** expose native `swarm_read`/`swarm_post` without requiring a shell in the T3 repository, and bind the author alias to the authenticated native thread. ChatGPT `t3_sessions.swarm` can read/post after OMCP-T deployment, but its declared alias currently lacks trusted per-caller verification.
3. **Verifier and completion lifecycle:** make verification/changes-requested an explicit workflow; distinguish delivery receipts from task completion and wake the coordinator on a persisted event, not polling.
4. **Scale and remote robustness:** reduce repeated full event-log scans, bound delivery history returned to mobile/agent tools, and ensure environment-specific board roots and transports agree on remote servers.

**Not yet proven:** a live native-to-ChatGPT-to-native round trip, cross-device UI, autonomous worker spawning, and a production upgrade of T3/OMCP-T. A source-only check does not imply that these features are available in the running desktop.
