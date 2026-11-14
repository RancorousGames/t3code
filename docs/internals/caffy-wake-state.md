# Caffy wake ownership and recovery

Caffy policy is keyed by the durable T3 browser/session ID. Public Bootstrap IDs are control aliases. A ChatGPT conversation ID is only a dispatch guard, never a monitor owner. `CaffyWakeMachine.ts` reduces verified events into durable wake intent and receipt transitions; `CaffyScheduler.ts` coordinates inventory, admission and persistence. `ChatGPTDeliveryQueue.ts` alone owns submission.

## Transition contract

| Input / condition | Transition | Persistent evidence |
| --- | --- | --- |
| New verified idle edge, idle/queued mode | Awaiting idle → ready | Event ID, sequence, stable message evidence key |
| Periodic deadline | Awaiting due → ready | Advance original cadence; coalesce missed deadlines |
| Paused or future start | Retain policy; no new claim | Pause flag / absolute beginAt |
| Assistant working / recovery / missing renderer | Retain intent; wait for safe recipient | Availability, check time and reason |
| Capacity admission | Ready → awaiting admission → claimed | Idle mode bypasses capacity; other modes retain admission policy |
| Claim | Ready → queued | Persist UUID and exact payload before enqueue |
| Guarded send begins | Queued → sending | Outbox saves submission before invoking renderer |
| Exact user turn observed | Sending/uncertain → confirmed → awaiting next event | Receipt and actual confirmation timestamp |
| Lost acknowledgement / generic IPC timeout | Sending → uncertain | Same receipt; reconciliation only, never blind resend |
| Verified no-submission receipt | Uncertain → queued | Exact conversation guard and expired submission lease |
| Conversation changes | Retain owner and policy | Cancel/rebind only a proven unsent queue record; unresolved receipts remain pinned |
| Renderer inventory missing | Retain monitor | Only explicit durable lifecycle actions can retire it |
| Explicit close/stop/complete or configured expiry | Retire policy | Outbox keeps historical receipts |

The displayed phase is a projection of policy, availability and the outbox receipt, not a second writable state machine. Each reducer transition advances `transitionVersion`. Queue receipts remain authoritative even if a callback or process disappears. `lastCheckedAt` is an observation, `lastWakeAt` is confirmed delivery; neither means assistant completion. Overdue checks remain visibly overdue rather than sliding forward in the tooltip. A paused or temporarily disconnected policy keeps its sidebar icon.

## Idle evidence and restart

Both Electron webviews and persistent Chromium publish through `chatGPTIdleTransitions.ts`. Safe idle requires an empty inspectable composer, no Stop control, no error/interruption/login signal and stable independent observations. User-only quiescence requires three seconds. A completion missed during a renderer outage can recover from a stable DOM message identity and two observations; increasing `totalTurns` is not evidence. Message identity deduplicates rehydration; timestamp-floored sequences avoid restarting at one after renderer journal loss. The desktop journal persists before notifying Caffy. New events and restart replay enter the same reducer.

Old stores with an already-consumed sequence and an observation newer than the last confirmed wake receive a one-time migration claim, persisted as an event ID. This repairs the historical sequence-61 / turn-count-5→4 incident without repeated wakes. Periodic stores missing a deadline recover from their original creation time and interval; idle mode has no periodic deadline.

The local named-pipe inventory is the scheduler's binding source. The server registry is a replicated UI/remote view, not a second wake authority. Incomplete inventories cannot migrate or retire owners. Dispatch still validates the actual mounted conversation, working state and draft immediately before submission. Browser recovery retains its existing draft and uncertainty safeguards; Caffy does not force reloads.

New Caffy deliveries include their UUID marker in the actual user turn. Persisted legacy pending deliveries retain their original payload format. A missing renderer recipient does not cancel a durable T3 message: a proven first-send refusal remains queued for an exact verified remount, while an earlier uncertain submission keeps its original ID for read-only reconciliation. Reconciliation is allowed while paused or capacity is unavailable because it is read-only. Queue admission is serialized separately from browser round trips, allowing other recipient lanes to progress during a slow request.

## Reproduction and limits

`CaffyRecovery.test.ts` combines real scheduler persistence and the real outbox with a controlled renderer transport. It reproduces uncertain-receipt loss and unsent-intent loss during rebinding, and exercises idle/periodic restart recovery with one guarded send followed only by reconciliation. Renderer journal tests cover cold completion, quiescence, DOM count reset and duplicate observations. Outbox tests model mount prerequisites explicitly and cover draft/focus refusal, wrong conversations, expiry receipts, crashes and independent recipient lanes.

A canceled application restart does not activate staged source. Build staging and live deployment must be reported separately. A stuck or uninspectable guest remains blocked with its policy retained; neither enqueue nor an idle registry label is proof of a delivered wake. Stable message IDs unavailable on a cold assistant page require a new witnessed generation/idle edge rather than guessing from turn counts. Unknown submissions require exact receipt evidence or explicit human resolution; conversation migration never clears them.
