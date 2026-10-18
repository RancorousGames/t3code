# Five-hour provider wake-up cleanup

The server-owned five-hour Codex/Claude wake worker launches a low-cost hello
conversation at the provider reset time. The separate
`ProviderResetWakeCleanupWorker` scans durable thread projections (including
after a T3 restart) and deletes _only_ disposable automatic hello conversations
once the assistant response is complete.

Criteria for deletion:

- Thread title is `5-hour session wake` and creation source is `server`.
- Exactly one completed run, finished at least **30 seconds** ago.
- Exactly one user message whose durable ID starts with `reset-wake:`, matches
  the run's user-message ID, and whose text is exactly `Say 'hello'.`.
- At least one non-empty assistant reply for that completed run; no streaming
  replies, system messages, or additional messages or runs.
- Thread remains visible/unarchived and unrenamed; explicit manual
  intervention protects it from automated deletion.
- IDs containing `:test:` are excluded. New manually triggered wake tests use
  the `5-hour wake test` title; user-queued messages use
  `Queued at provider reset`, even when no explicit model was chosen.

The cleanup scanner runs on the existing server scheduler, throttled to one
scan per 15 seconds. It dispatches the normal durable `thread.delete` command
with a deterministic per-thread command ID. It does not delete incomplete,
failed, resumed, or user-continued conversations, nor any queued real work.
Failures are logged and the next scan can retry. Hidden/archived threads are
not deleted merely due to inactivity.

Deleting a thread here is the same server-side thread deletion used by T3's
normal UI. The behavior applies only to the minimal, automatically generated
hello probes; it does not automatically remove or cancel running Claude/Codex
sessions.
