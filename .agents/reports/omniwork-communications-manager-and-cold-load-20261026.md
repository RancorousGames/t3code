# Omniwork communication manager and cold-message recovery — 2026-10-26

## Shared skill
Created `C:/Users/crovea/.agents/skills/omniwork-communication/SKILL.md` (short trigger description: read for sending to Omniwork inboxes or agents, registering addresses, troubleshooting unloaded sessions). Ran `node C:/Users/crovea/.agents/sync.mjs`; installed across shared agent skill locations. Covers OpenRig registration, real binding/adoption, exact queue/recipient, durable human inbox replies, normal/direct T3 send, wake, status evidence, and medium-integrity Windows IPC.

## Managed seat
- Rig `omni-command`, node `workers.communications-manager`, canonical address `workers-communications-manager@omni-command`.
- Seat ID `01M5W6K9A409EEA7650Q3W2GSS`; T3 browser UUID `90d4f686-d7fb-451a-a528-4fb81b7b9004`; conversation ID `6adf570d-312c-83ed-ad8a-0de10f6050f8`.
- A real T3 ChatGPT manager browser was created and answered its bootstrap. The initial managed create returned UNKNOWN/timed out. Did NOT replay create. Explicitly adopted the independently verified existing browser conversation to that seat with `operationId 5c947596-646c-48d8-bf03-906f9d2c21b8` and verified active primary session `34cde74e-2523-456f-8af7-2fcee37d7240`. The old indeterminate operation is retained in audit. This is a separate ChatGPT conversation, not a transfer of the requesting chat's model runtime identity.

## T3 source fix and deployment
- `apps/web/src/components/desktop/DesktopAppActivationCoordinator.tsx`: For one exact existing unloaded T3 session, target a delivery mount on send/reconcile and direct-send read preflight, including when caller omitted expected conversation; derive only from the saved exact canonical conversation and verify it again against the live mounted guest before changing its composer.
- `packages/contracts/src/desktopAppActivation.ts`: optional `wakeForSend` guarded read activation.
- `scripts/chatgpt-sessions.mjs`: ordinary `send` now does one targeted wake/read and enqueues into T3 desktop's durable queue (optional stable `messageId`). No manual-click fallback; busy sessions are queued, not rejected for processing.
- Focused tests: 22/22 Node CLI; 60/60 T3 web selected suites, earlier combined 73/73. No changed-file TypeScript diagnostics; five unrelated preexisting web type errors. Scoped diff check clean.
- Build successful `vp run build:desktop`; gracefully restarted T3.
- **IPC root cause:** OpenRig daemon PID 33020 runs at medium integrity (`S-1-16-8192`); previous T3 high integrity (`S-1-16-12288`) refused daemon pipe connections `EPERM`. T3 was relaunched from medium Explorer after graceful close. Latest process **PID 39032**, medium token, responsive; no forced termination; delivery journal backed up. Future maintainer MUST keep T3 at medium integrity.

## Evidence: browser deliveries
- Direct T3 sent to formerly unloaded T3 manager `f0ca1aa8-7c32-4f88-aebf-a9b1faabcde6`: message `36a70afd-f246-4254-a9e8-cf867e161282` => T3 status `delivered` (3 attempts, 0 duplicate sends).
- **Human Inbox end-to-end return:** Created inbox `qitem-comms-manager-reply-test-20261026`, `replyEligible:true`. Human actually replied `I got ur msg` via T3. OpenRig persisted reply `qitem-t3-operator-reply-1cf4d25a558596250a3b2016dae515a5fd8455cb` from `human@kernel` to registered manager. OpenRig `lastNudgeResult: accepted:t3-browser:t3_delivery_durably_queued; task_not_claimed`; matching T3 message `e5bc698f-6f2d-4736-802b-29f8b0160218` was `delivered` on first attempt. **No manager assistant-response receipt** established; last observation of its guest was `pending_or_stalled` (idle assistant placeholder).
- Other OpenRig cold-wake test `qitem-comms-manager-coldwake-20261026` initially `connect EPERM` but was automatically re-nudged after medium-integrity restart and reached durable T3 queue (`accepted:t3-browser:t3_delivery_durably_queued`). Matching T3 message `1aa504b6-2b30-400a-837a-b3020d48b760` remained `sending` with repeated guarded attempts because the recipient chat had an unanswered assistant placeholder. **It was not confirmed delivered.** Leave queued rather than force or manually replay.

## Limitations / follow-up
Human reply is **persisted and observed in browser** but no agent answer to it was confirmed. The manager browser can be automatically unloaded again after delivery by the independent memory policy; this is normal, not lost delivery. The second test must not be re-created or duplicated while existing queue record is pending. Do not restart T3 from an admin/elevated OMCP shell; use normal medium-integrity Explorer. No unrelated changes staged, discarded or committed.
