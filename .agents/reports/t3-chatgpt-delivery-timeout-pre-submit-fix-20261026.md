# T3 persistent ChatGPT delivery — timeout and duplicate-risk recovery

Date: 2026-10-26. **SOURCE ONLY: DO NOT deploy or restart T3 before the user's later live test.**

## User decision (supersedes original exactly-once preference)

User explicitly prefers a small, clearly prefixed risk of duplicate messages over permanently missing delivery. They do not want rapid repeated messages.

## Implemented behavior

- An initial browser send receives a persisted 70-second expiry, enforced on entry, before typing, and in the final guest DOM click operation. The desktop broker timeout is 90 seconds.
- A missing acknowledgement enters UNCERTAIN. Before any retry the queue attempts read-only reconciliation by exact conversation and durable message ID.
- A verifiably pre-submit-aborted attempt is retried without a duplicate warning.
- An ambiguous submission may be resent **at most twice**, after **5 minutes then 15 minutes**, preserving the same `[T3-MSG:<messageId>]` marker and inserting:
  `[POTENTIALLY DUPLICATE: earlier delivery unconfirmed. If already received, ignore this repeat.]`
- The resubmission count and last submission time are persisted BEFORE dispatch and survive desktop restarts. No unbounded rapid resend loops. Unresolved after the two budgeted attempts becomes `needs_attention`.
- Existing legacy `needs_attention` records that have not consumed their duplicate-resend budget are eligible for this treatment too. On deployment, old queued coordinator and Wartribes test messages might be reattempted (user explicitly accepts this).
- The browser checks exact session/conversation, idle status, and composer content. An old UNKNOWN click fence may be quarantined only after positive two-probe empty-composer checks, age >=120 seconds, and same marker; archived original evidence is retained. New duplicate retry may then submit with the warning, or if the original automated text is already staged in the editor, guarded-click that exact text instead. Any differing/human draft is preserved and never clicked/overwritten.
- The actual guest Send click now verifies the exact text in the editor and the expiration deadline atomically immediately before submitting. Positive delivery receipts persist before UNKNOWN fences are released.
- Work completion is never inferred from acceptance or sending. The message may still need an app-specific response and confirmation.

## Related coordinator failure

The coordinator browser 75a6ef99-1f30-4ac3-afe2-4ced0ad7a849 was observed `pending_or_stalled`, with unresponded user turns. That is not the identical root cause as a renderer timeout / ambiguous click. This patch may recover a later idle delivery but **does not bypass the explicit no-concurrent-turn preflight**. Do not force sends into an active or pending generation.

## Files

- apps/desktop/src/app/ChatGPTDeliveryQueue.ts and .test.ts
- packages/contracts/src/desktopAppActivation.ts
- apps/web/src/components/desktop/DesktopAppActivationCoordinator.tsx
- apps/web/src/chatGPTSessionControl.ts and .test.ts
- apps/web/src/chatGPTUncertainSendFence.ts and .test.ts
- apps/web/src/chatGPTWebviewAutomation.ts
- Shared `C:/Users/crovea/.agents/skills/llm-integration-guide/SKILL.md` updated to note prospective policy and required deployment.

## Tests and limitations

- **49 focused tests pass in 3 suites**: queue persisted retry limits/restart, old needs_attention migration, browser UNKNOWN recovery and staged editor, human-draft guard, durable send receipt.
- Command: `.\\node_modules\\.bin\\vp.CMD test run apps/desktop/src/app/ChatGPTDeliveryQueue.test.ts apps/web/src/chatGPTUncertainSendFence.test.ts apps/web/src/chatGPTSessionControl.test.ts --exclude '**/.claude/worktrees/**`
- Scoped web/desktop typechecks report **no changed-file errors**; unrelated pre-existing diagnostics remain in session-grouping/sidebar and Effect OpenRig tests.
- The separate `chatGPTWebviewAutomation.test.ts` suite cannot bundle on this machine due to the existing `node:sea` / HostProcess Vite test environment conflict. New Send-click behavior was covered through the control fixture; real browser remains untested.
- T3 executable was *not rebuilt, deployed or restarted*. Its Windows GUI remained process PID 46976 (started 02:36 local). Existing live journal/drafts/sessions unchanged.
- T3 checkout contains many foreign dirty edits. Preserve them; never blanket stage, stash, reset or commit others' changes. No commit was made.

## Later live test (requires explicit authorization)

1. Review integration diffs and build/deploy T3 in a coordinated restart; preserve sessions/drafts.
2. Test an approved disposable session: unavailable at first send, recovery/reconciliation, duplicate-risk resend only after cooldown, exact conversation and marker, no rapid repeats.
3. Test click-UNKNOWN and user typing simultaneously; verify no original user draft is clicked or overwritten (T3-0085).
4. Inspect Coordinator old `2206f642-57ba-46b5-a4eb-e6caccb60416` and Wartribes `d88713ec-9b13-4ab0-82cf-2c669dc05792` without manually replaying until the runtime is upgraded. Expect old messages to become eligible for controlled marked retry after upgrade.

**Status: coded + focused tests pass; NOT DEPLOYED / not live verified.**
