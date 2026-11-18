# T3-0281: Native T3 context and tool-failure forensic audit (revision 2)

**18 November 2026.** This supersedes the quick first-pass audit in commit `9604427c70`. Read-only audit of Claude Agent SDK and Codex native T3 sessions (not ChatGPT browser conversations). No production changes, builds, restarts, or agents. Audit methods: `C:/Users/crovea/.agents/skills/extra-skill-finder/on-request/context-audit/SKILL.md`, modes 1 and 2.

## Top 3 changes to save tokens now

1. **P1 / startup: exclude Claude's 37,093-character `Artifact` tool definition when not needed.** In native first-request shapes it appeared in **128/197** T3-linked Claude sessions. Schema serialization medians: **75,937 characters with Artifact vs 37,739 without**. Within Haiku and Opus cohorts the larger-schema group shows ~**14.6k–15.5k more first-request logical input tokens at the median**. **This is association, not a causal savings estimate.** Target: Claude SDK selected-tool policy, `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` around line 1594. Retain for actual artifact requests. Acceptance: identical model/source/task before/after, measured native first `message.usage`, no loss of required Artifact capability.
2. **P1 / startup: narrow MCP server instructions to project/task scope.** The Claude first-request system-message blob median is **37,591 characters**, *in addition to* the **16,704-character median `shape.system`** serialized component. Server-named sections can be tens of thousands of characters: 82 sampled sections under `claude.ai Claude Docs` (~31.8k-character median section span), 26 under `omnimcp-lite` (~24.1k). These are character spans, not measured token contributions. Target: MCP server selection and Claude adapter `mcpServers` plus appended system instructions around lines 1642–1655 and 1781–1810. Measure matched first-request shape/blob and actual input-token deltas; verify required tools remain available. Don't remove necessary AGENTS/project instructions.
3. **P1 / tool output: use bounded inventories and continuations rather than broad operational dumps.** Last-week activity contains **439 tool responses with >=10k text characters**, **36 >=50k**; **423** of the large responses are command executions. Direct text outputs total **18.14m characters**, wrapped text another **0.92m**. These are persisted text fields, *not billed or necessarily model-visible tokens*. Target: status/search/log/list APIs and agent usage, with complete results retrievable by ID/position. Acceptance: model-visible tool-output telemetry, correct relevant-field recall, and no extra follow-up churn.

**Correction:** a blanket duplicate-call blocker is **not** justified. The first audit's 343 repeated signatures included normal repeats across *different runs*. Restricting to one run yields **153 exact same-input next-pairs**, only **46** after failed calls, **15** where both failed, and only **3 of those** with identical output. Changing state and valid retry are common; use contextual hints, never indiscriminate suppression.

## Scope, provenance, denominators

| Source | Sample | Interpretation |
|---|---|---|
| T3 v2 SQLite projection (`D:/SSDProjects/Tools/t3code/.t3/userdata/statev2.sqlite`, `mode=ro`) | **844 threads**, **2,570 runs**, **74,392 activity items** at initial discovery | Separate units; a T3 thread can contain many runs/turns/native provider sessions |
| Recent workflow slice, **2026-11-11 to Nov 18 capture** | **93 recently updated nondeleted T3 threads**, **496 requested runs**, **47 threads with relevant tool activity**, **7,571 tool/error items** | Items filtered using actual `startedAt` where available, not merely record update time |
| Native Claude JSONLs | 371 files discoverable, 287 T3-linked native thread refs, **197 matched files with positive first assistant usage** (66 first used during last 7 days) | First-request usage for a **subset**; 90 linked refs unmeasured |
| Native Codex JSONLs | 67 files discoverable, 387 T3-linked native refs, **59 matched files with positive first `token_count`** (52 in last 7 days) | First-request usage for a **smaller, selection-biased subset**; 328 refs unmeasured |
| T3 provider-turn projections | **2,250 provider turns**, 2,175 with `tokenUsage`, **2,080 with numeric `inputTokens`** | Turn-level usage may aggregate several requests and sometimes exceeds `maxTokens`; **not a snapshot of context-window fullness** |

Native linkage is via `orchestration_v2_projection_provider_threads.payload_json.nativeThreadRef.nativeId` matched to native filenames. For Claude, the first distinct positive-usage assistant `message.id` provides logical input = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. For Codex, use the first positive `event_msg.payload.type=token_count`, `info.last_token_usage.input_tokens`; cached input is a component of that total, not additional tokens. De-duplicate streamed assistant snapshots by message ID. Native files may contain restored/imported context; "first native request" does not always mean fresh minimal context.

### Measured logical input of first native model response (tokens)

| Sample | N | Min | P25 | Median | P75 | Max |
|---|---:|---:|---:|---:|---:|---:|
| Claude all | 197 | 32,332 | 37,528 | **47,805** | 54,262 | 65,290 |
| Claude T3 root | 171 | 32,332 | 36,836 | **47,609** | 49,731 | 65,122 |
| Claude delegated child | 26 | 33,451 | 55,633 | **57,090** | 58,583 | 65,290 |
| Codex all | 59 | 19,669 | 19,852 | **21,539** | 22,626 | 28,205 |
| Codex T3 root | 55 | 19,669 | 19,852 | **21,496** | 22,127 | 28,162 |
| Codex delegated child | 4 | 26,686 | 26,686 | **28,181** | 28,193 | 28,205 |

Claude first usage has median **41,692 cache-creation input tokens**, median **0 cache-read tokens**, and median **2 uncached input tokens**; **149/197** first observations have zero cache reads. Codex first usage has median **19,975 uncached input tokens** and zero median cached reads. These are different provider accounting regimes: **no cross-provider claim about costs or model efficiency** follows. Root/child differences are also confounded by project, inheritance and model selection.

Observed *first native message* model labels: Claude `claude-haiku-5-5` (117), `claude-opus-5-5` (67), `claude-fable-5-2` (8), smaller Sonnet/older Haiku groups; Codex `gpt-6-luna` (40), with smaller Sol/Astra/Terra groups. Do not assume one model for a whole thread. In Claude Haiku samples, first logical-input median with >60k tool-schema characters is **49,136** (n=71) versus **34,489** (n=46) with smaller schemas; for Opus, **55,908** (n=45) versus **40,392** (n=22). Co-varying AGENTS text, MCP servers, resume state and task type prevent causal attribution.

### Source anatomy: what actually fills the first request?

A linked Claude example is native JSONL `C:/Users/crovea/.claude/projects/D--Wartribes/a7e68ed4-6f81-42d1-b96f-bf036b6ae6d1.jsonl` (T3 thread `7ed3b062-4c47-4680-855a-d7bd2b503726`): first native assistant usage **59,244 logical input tokens**; first `api-request-shape` has ~**18.7k characters** of `system` and ~**76.0k** of tool definitions, including ~**37.1k** for `Artifact` (21,848 description plus 15,245 schema). First `api-request-blob` has ~**31.4k characters** user-role content (26.4k codebase/user instructions) and ~**41.4k characters** system-role content (provider environment and MCP instructions). These are *different request components*, not proof that T3 injected everything, nor exact token attribution. Across 197 matched Claude native starts, medians are: `shape.system` **16,704 chars**, `shape.tools` **75,610**, first system-role blob **37,591**, and earlier user-role reminder parts **8,267**. The final user-role part alone is not a valid proxy for the original request.

A matched Codex example, native `rollout-2026-11-18T07-58-44-01a1ed73-6254-7361-8e97-aec5df50a962.jsonl`, recorded **21,625 first input tokens**. Initial developer segments include approximately **17.8k characters of provider base instructions**, **19.3k of skill catalog**, **4.1k of deferred tool namespaces** and role/mode instructions; first user-role instruction block is ~**7k characters**. Median combined developer message text across 59 matched Codex files: **50,770 chars**. `session_meta.base_instructions` duplicates an instruction source and must **not** be added again on top of corresponding developer messages. Catalog metadata is not the same as loading every full SKILL.md.

**Implementation ownership:** `ClaudeAdapterV2.ts:1594` controls SDK tool selection; `:1643–1655` uses the `claude_code` prompt preset *plus* T3 runtime/orchestration instructions; `:1781–1810` passes selected MCP servers. Provider-internal base prompt, MCP server instructions, user/project AGENTS and T3 additions must be treated separately. To instrument correctly, record per model request: context block ID/source/hash, inclusion trigger, fresh/replay status, first/continuation turn, model-visible input tokens, cache-write/read tokens, and tool-output delivery bytes. Keep prompt bodies out of shared telemetry. Changing mandatory project policy just to reduce startup characters is unsafe.

## Recorded failures: correct the denominator and distinguish causes

| Item type | Completed | Failed | Cancelled/interrupted |
|---|---:|---:|---:|
| `command_execution` | 4,428 | **297** | 13 |
| `dynamic_tool` | 1,637 | **95** | 3 |
| `file_change` | 1,067 | **1** | 0 |
| Provider `error` item | 0 | **30** | 0 |

Thus **393 failed tool items / 7,541 tool items (~5.2%)**, and **30 separate provider errors** (29 usage-limit, 1 transport). This is a *persisted failure-event rate*, **not** defective-tool frequency or unsuccessful-task frequency. Commands returning nonzero status are commonly intentional searches, checks or controlled probes. Specifically, **152 failed command records have no explicit error string** in normalized output, so do not guess their root cause. The first pass's **418 failures** and **120 "tool failures"** were an unreliable string-classification inventory, not independent bug counts. The preliminary filter also relied on update time, not actual execution start. Both flaws are corrected here.

### Concrete recurring cases, backed by stable item IDs

| Observed pattern | Interpretation | Specific reduction |
|---|---|---|
| **10** `mcp__t3-code__delegate_task` errors: "Start the T3 desktop app before delegating to ChatGPT." Sample `turn-item:provider:claudeAgent:native-item:toolu_01NhV95EtHLpkpGKZdSV2995`, thread `7ed3b062-4c47-4680-855a-d7bd2b503726`. | Desktop/capability readiness mismatch, **not** invalid task ownership. | Preflight readiness and return explicit recovery condition; don't keep resending unless status changes. |
| **12** `agent-coordination.reserve_editor` failed items. Sample `turn-item:provider:codex:native-item:exec-ca6b72fb-f3b6-4e8d-9672-9da32305d4f4`. | Contended exclusive editor/build lease is **expected coordination**, not automatically a defect. | Provide concise lease holder and when to retry; avoid busy retry. |
| **3** Claude `Read` failures explicitly state **31,186 tokens > 25,000 maximum**. Sample `turn-item:provider:claudeAgent:native-item:toolu_01A1xHUwSMF9DXD2XNdsHNDG`. | Agent requested overly large file read. | Use offset/limit or targeted search; don't raise global limits. |
| **3** `t3_background_wait` invalid arguments (missing `taskIds`), example `toolu_01VQaxB7TcvPwBZ9qMtyDsBx`; **3** `task_status` cross-thread ownership errors; **3** `t3_sessions` invalid action errors. | Tool schema/ownership confusion or stale session references; model vs tool defect not yet established. | Expose allowed actions, task IDs and owner in a concise typed error; agent should adjust arguments once rather than repeat unchanged call. |
| **24** command records tentatively identified as missing paths, **13** argument/parse failures, **9** missing commands, **20** timeout-like and **152** without explicit error text. | Shell, environment and malformed path cases mixed with legitimate nonzero exits; heuristic counts can overlap semantics. | Persist `exit_code`, shell, cwd, stderr and structured failure cause separately; prompt models with shell-specific syntax. |

Counts above are *items* and some retries belong to the same incident. Sample names/IDs are intentionally stable references into private local T3 activity, not links to public task content. Extended error inventory: `E:/_AgentScratch/Tasks/t3code/T3-0281/tool_failure_patterns.csv`.

### Rethinking repetition and recovery

The first report's **343 signatures and 1,295 repeated invocations** grouped identical inputs across a *whole T3 thread*; status checks, valid polls, reads of changing files, and separate runs inflated this. New grouping by **thread + run + tool + SHA-256(canonical input)**, ordered by event start time:

- **153** repeated-input next-pairs within the same run.
- **46** have a failed predecessor; **15** have failed status on both sides.
- Just **3/15** failed->failed pairs have unchanged returned output. At least one same-error pair is a delegation attempt during desktop unavailability: `toolu_011K7mkpeqhEj95V4xdJdkzM` followed by `toolu_013i2mBQrCXD979vKbNvrULE` in T3 thread `7ed3...`.
- A changed output does not *prove* new relevant state, but strongly argues against assuming every repeat was wasted. A command may legitimately retry after a lease expires, a server launches or source changes.

Therefore **do not implement a blanket exact-call suppressor**. If a helper is added, scope it to *same failed input + same actionable error + no relevant prerequisite change* and allow explicit override. The audit provides hashes and stable item references in the local `run_repeat_pairs.csv` without publishing private raw tool arguments.

### Context/output volume is not the same as billed tokens

The recent slice contains **7,542 tool items (including some without output fields)**. Text fields of **439** items contain >=10k characters (423 commands, 5 session reads, 4 Grep, 3 T3 thread reads, 3 preview snapshots and 1 task status); **36** contain >=50k. The projection holds **18,143,284** characters of direct tool-output strings and **915,782** of wrapped text; separately, there are **1,542,026** characters of serialized `structuredContent` and **1,128,596** base64 image characters. These must **not** be added as if all were readable textual model context.

For example, `mcp__OMCPT__t3_sessions` item `toolu_01TsxZ1sJ3c5CrhGCVdRVm8k` has a **~725k-character serialized output**. Yet its model-directed `content` string is **~1.5k characters** announcing that an enormous result was saved to a file; the bulk resides in `structuredContent`. Similarly, `preview_snapshot` item `toolu_012xXnfSi7yJX8xkdi2F7mJu` contains base64 PNG media. Exactly **4** overflow wrappers were found in the relevant slice. Without instrumenting what the SDK actually sends to the model, claiming "27m output chars wasted context" is incorrect. The first audit implicitly made this mistake.

There is useful scope for bounded text results, but the correct target is *model-visible text, size, and retrieval behavior*. Over-aggressive output truncation can hide the very failure needed to fix a bug. Favor typed summaries with stable `itemId`/continuation and explicit full-result retrieval.

## Recommendations by owner and risk

| Priority / type | Target & precise change | Baseline and acceptance | Caveat |
|---|---|---|---|
| **P1 startup** | T3 Claude SDK tool selection (`ClaudeAdapterV2.ts:1594`): omit heavy Artifact schema unless capability needed | 37,093-char definition; 128/197 first shapes. Repeat same request under identical model/state and compare logical input + success | SDK may control some built-ins; opt-in must remain |
| **P1 startup** | T3 managed MCP configuration and Claude adapter (`:1642–1655`, `:1781–1810`): project/task-scoped servers and injection | Many tens-of-thousands-char server sections. Measure native shape/blob and same-work token delta | Keep required project policy/server capabilities |
| **P1 tool output** | T3/CLI status/search/log/read APIs: bounded summaries then continuations | 439 >=10k text outputs; 4 saved-result wrappers. Measure actual model-visible bytes and follow-up calls | Preserve access to full error evidence and images |
| **P2 instrumentation** | `usageTranscriptReader.ts` plus Claude/Codex adapter: request block IDs/hashes, replay/cache attribution and delivered-result size | 256 measured native first calls but no per-block tokens. Attribution totals should reconcile with provider request usage | Avoid logging private prompts, cached fragments or credentials |
| **P2 reliability** | T3 delegation capability API and task/session schema errors: readiness and owner-aware suggestions | 10 desktop-unavailable, 3 wrong `taskIds`, 3 owner-mismatch status calls | Outages should remain retryable after state changes |
| **P2 diagnostics** | Preserve native shell exit code, cwd, stderr, execution status separately when projecting commands | 152 normalized failed commands have no explicit error text | Requires adapter-level mapping without changing command semantics |
| **P3 guidance** | Use bounded Read and target-native shell syntax; contextual, opt-out retry hints | 3 oversized Read calls, 15 same-input failed->failed in-run pairs | Do not install redundant tests or generic retry bans |

No numeric **expected token savings** are defensible without controlled before/after requests. For Artifact, the ~14–15k first-call median token differences are cross-session associations, not a promised change. For other work, use observed character counts as *potentially avoidable serialized input*, never billed-token estimates.

## Limits, private evidence and next implementation boundary

This audit covers **locally retained native JSONLs mapped to T3**; missing files make coverage unequal, particularly for Codex. The T3 projection is an operational snapshot, not a provider request transcript; `tokenUsage.inputTokens` can aggregate multiple calls and exceed `maxTokens`. Repeated `compaction` items (~79 in the early updated-thread inventory) are context-lifecycle events, not evidence of failure to fit a window. Do not conflate native provider model labels, T3 default provider and per-run model switches; no cross-model capability ranking is attempted.

Source-only character sizes, text in user/project reminders, serialized MCP structured outputs and image data can overlap or be non-model-visible. Source files, first recorded assistant usage and stable tool item IDs are needed for verification. The provider's own large Claude tool and server definitions are not all owned by T3; confirm actual adapter control before implementing. A generated preamble or role instruction cannot be removed if doing so would violate global/project authorization policies.

Private, reproducible local evidence: `E:/_AgentScratch/Tasks/t3code/T3-0281/first_context.csv`, `claude_context_sources.csv`, `context_turn_usage.csv`, `tool_failure_patterns.csv`, `run_repeat_pairs.csv`, plus `native_audit.py`, `mcp_profiles.py`, `turnusage.py`, `failure_deep.py`, `output_profile.py`. The original first-pass repository `threads.csv`, `failure_examples.csv`, and `repeated_calls.csv` are **superseded** and should not be used as proof of current conclusions. Do not export private transcripts, native prompt bodies, reasoning blocks or tokens. Reproduction requires read-only `mode=ro` SQLite and native usage events; T3 activity should be paged with `view=activity`, stable `itemId`/position and `nextTextOffset` for truncated text.

**Completed audit outcome:** native startup token measurements established, major source contributors traced, operational failures separated from rate limits/expected lock contention, repeated-call counts corrected, and small measurable improvements identified. Implementing provider or app behavior is separate work from this read-only audit.
