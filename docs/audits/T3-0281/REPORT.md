# T3-0281 — Native T3 thread context and tool-failure audit

**Window:** 2026-11-11 through 2026-11-18 UTC. **Source:** read-only `D:/SSDProjects/Tools/t3code/.t3/userdata/statev2.sqlite`, orchestration v2 projection.

**Coverage:** 93 recently updated threads ({'codex': 49, 'claudeAgent': 44}), 496 runs requested in window, 15315 updated activity items. Counts are different denominators. Historical threads updated in window may contain earlier work; item filter uses update time, not guaranteed execution time.

## Top 3 changes to save tokens now

1. **P1 / tool-output:** Return short failure summaries and capped stdout by default, with explicit continuation for needed evidence. Baseline: 388 failed tool items; quantify actual token savings only after model-visible output instrumentation.
2. **P1 / model-turn churn:** Detect repeated identical failed tool inputs within a thread and surface previous error and corrective hint. Baseline: 343 repeated input signatures (not all waste; includes valid polling and repeated state checks).
3. **P2 / startup:** Instrument per-context-block source/hash and model-visible token counts at provider request boundary. Startup token attribution is not exposed in the inspected T3 projection; do not infer from text lengths.

## Specific token-saving recommendations

| Priority | Target | Evidence | Change / acceptance |
|---|---|---|---|
| P1 | T3 activity/tool result projection | Failed item counts and examples in `failure_examples.csv` | Compact tool errors to code + one actionable line; retain full output on demand. Measure output characters and model-visible tokens before/after. |
| P1 | Native tool dispatcher / agent guidance | `repeated_calls.csv` contains exact per-thread repeat signatures | On identical failure, suggest inspect/alter arguments before retry; preserve legitimate polls. Measure unchanged failed retries per 100 tool calls. |
| P2 | Provider request adapter | Startup attribution absent from v2 projection | Log block ID, source/hash, inclusion trigger, logical input tokens and cache reads/writes; check first-turn delta without exposing private prompts. |
| P2 | Tool activity pagination | Large command/tool outputs not characterized by token field | Record truncation and output size; prefer focused search paths over whole-tree dumps. Measure follow-up reads and missing relevant matches. |

## Failure inventory

- Failed actionable tool/error items: **418**; by type: **{'command_execution': 296, 'dynamic_tool': 91, 'error': 30, 'file_change': 1}**.
- Classification is heuristic over structured failure/output fields; `other/unknown` means insufficient detail, not absence of failure.

| Type | Likely class | Count | Example thread / item |
|---|---|---:|---|
| command_execution | tool failure | 120 | `6d6269f2-5c58-4387-9aac-4850d461798a` / `turn-item:provider:codex:native-item:exec-e7344c7c-9288-44ba-88a6-c797391a7396` |
| command_execution | other/unknown | 71 | `6d6269f2-5c58-4387-9aac-4850d461798a` / `turn-item:provider:codex:native-item:exec-38ecfcba-6e56-42c9-bfef-cb7f89492465` |
| dynamic_tool | tool failure | 62 | `6677c5d8-f70e-47bd-b62a-639630b137b2` / `turn-item:provider:claudeAgent:native-item:toolu_01WEB9dkE8WN9swKck88FePJ` |
| command_execution | missing path or command | 44 | `6d6269f2-5c58-4387-9aac-4850d461798a` / `turn-item:provider:codex:native-item:exec-1c0975db-2386-4e84-af07-f4f8da164829` |
| error | usage/rate limit | 28 | `6677c5d8-f70e-47bd-b62a-639630b137b2` / `turn-item:provider:codex:native-item:terminal-failure%3Aprovider-turn%3Aprovider%3Acodex%3Anative-turn%3A01a1c879-9360-7b33-ba61-f6f09acbd407` |
| command_execution | timeout/cancel | 26 | `6d6269f2-5c58-4387-9aac-4850d461798a` / `turn-item:provider:codex:native-item:exec-1ef024f0-987b-46d4-b160-5334cc7d7632` |
| command_execution | shell/argument syntax | 22 | `6d6269f2-5c58-4387-9aac-4850d461798a` / `turn-item:provider:codex:native-item:exec-1a339607-75b9-4e77-910d-70a44b01720a` |
| dynamic_tool | permission/coordination | 17 | `6677c5d8-f70e-47bd-b62a-639630b137b2` / `turn-item:provider:claudeAgent:native-item:toolu_01MHx6UExLxWB1SNaoT8zuQa` |
| command_execution | permission/coordination | 13 | `120834b7-eb2a-491d-8e25-a19c04f05b0d` / `turn-item:provider:codex:native-item:exec-f5ba2500-da4f-4f53-81c5-5e036926cc16` |
| dynamic_tool | missing path or command | 7 | `6677c5d8-f70e-47bd-b62a-639630b137b2` / `turn-item:provider:claudeAgent:native-item:toolu_01PSTwtC1vfnVKTQHcVEDKYN` |
| dynamic_tool | other/unknown | 3 | `6d6269f2-5c58-4387-9aac-4850d461798a` / `turn-item:provider:codex:native-item:exec-37ad41f3-938a-44ad-9053-d60e490f1db1` |
| error | tool failure | 2 | `6677c5d8-f70e-47bd-b62a-639630b137b2` / `turn-item:provider:claudeAgent:native-item:terminal-failure%3Aprovider-turn%3Aprovider%3AclaudeAgent%3Anative-turn%3Aturn%253Arun-attempt%253Arun%253Arun%25253Athread%25253A6677c5d8-f70e-47bd-b62a-639630b137b2%25253Aordinal%25253A9%253Aattempt%253A1` |
| dynamic_tool | timeout/cancel | 1 | `thread:delegated-task:command%3Amcp%3Aaf2dcbec-f599-46b8-8a28-664e26278693%3Adelegate-task%3Ad30686a5-2dc7-46be-9f81-85d7cd865d10` / `turn-item:provider:claudeAgent:native-item:toolu_01BrBg6ckyRFakD1wEzZkAy1` |
| dynamic_tool | shell/argument syntax | 1 | `a3876a98-d486-43b7-9d2f-7c9fbd74d5f6` / `turn-item:provider:claudeAgent:native-item:toolu_01ANqqRoKPaGqvc23ur3TNna` |
| file_change | tool failure | 1 | `thread:delegated-task:command%3Amcp%3Ac0ba555f-bd80-41c9-810a-a6f0e900bc00%3Adelegate-task%3Aced656e6-1885-436a-b4e1-084c2a95a83d` / `turn-item:provider:claudeAgent:native-item:toolu_011uFcwUawBST2qQ2quss4ro` |

## Context usage

- Compaction activity items in scope: **79** (not equivalent to context-window exhaustion).
- The T3 v2 projection does not provide validated first-model logical input tokens or a per-block attribution ledger. **Measured startup context: unavailable**, not zero. Provider-native usage records would be needed to separate cached reads, cache creation, uncached input, and resumed turns.
- Source inventory to inspect at adapter boundary: provider base instructions; T3 runtime/developer injection; global and project AGENTS; deferred skills/tool schemas; user request and resume history; post-start tool output. Do not assume all AGENTS files were injected.

## Workflow efficiency

- Exact same input signature repeated at least twice within a thread: **343** signatures, totaling **1295** invocations. This is an upper bound on avoidable repeats: state changes, polling and retries may be justified.
- Full per-thread counts and stable IDs are in `threads.csv`, `repeated_calls.csv`, and `failure_examples.csv`; raw tool inputs and private prompts intentionally excluded.

## Limits and follow-up

- No model-family comparison: task selected native T3 context/tool failures, not a cross-model failure-pattern audit.
- Counts are derived from persisted projection items, not native provider JSONL. Provider run metadata can change model mid-thread; provider labels alone are not model comparisons.
- Structured failures and repeated signatures require case-by-case inspection before assigning blame to the agent, tool, environment or concurrency.
- This audit is read-only; no production code, running threads or sessions were changed.
- Next targeted pass: inspect highest-repeat failed sequences via T3 activity pages and provider-native first-turn usage for sampled threads, then validate the proposed fixes against model-visible telemetry.
