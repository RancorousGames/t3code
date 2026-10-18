# Background agent wakeup policy

The T3 server suppresses new app-generated completion prompts by default, including delegated-task completions and Codex background-command notifications. Delegated results remain in durable task/thread projections and can be retrieved through task status when the parent next runs. Codex command results are projected before the prompt offer is suppressed.

Provider-buffered continuations are still dispatched. Claude, ACP and OpenCode use these to ingest output their provider already produced; the adapter drains its buffer without sending the placeholder message as a new prompt. Suppressing that dispatch would strand output in memory. These ingestion runs can therefore appear in the timeline even with automatic prompts disabled. Provider CLIs may also initiate their own background model work; this setting does not prevent it.

Implementation: `apps/server/src/orchestration-v2/ProviderContinuationService.ts`. The default outside test runs is `T3_AGENT_AUTOWAKE=0` (implicit; no environment configuration required). Set `T3_AGENT_AUTOWAKE=1` on the server when new automatic completion prompts are desired. The setting takes effect after server restart/rebuild; explicit user messages and active runs are unaffected.

Do not write another per-subagent manifest: the T3 task/thread projections and task-status retrieval already persist subagent lifecycle and results automatically. Recovery tests cover child results across restart. This policy suppresses delivery as a fresh prompt, not the record of completion.
