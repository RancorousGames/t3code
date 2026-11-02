# ChatGPT blank browser investigation — 2026-10-25

## Automatic native-failure recovery fix — 2026-10-26

`HostedBrowserWebview` now installs lifecycle listeners during the layout effect,
handles both `render-process-gone` and `destroyed`, and checks `isCrashed()` after
registration. A ten-second attachment deadline replaces a guest that never registers,
including a launch failure whose event was missed. Each replacement gets its own
deadline and uses the existing crash retry/backoff policy; recovery does not depend
on `dom-ready`, guest JavaScript, or a successful URL read from the failed guest.

Native failure evidence is retained per guest and classified immediately as
`browser-unresponsive` (`renderer-gone`), before DOM inspection or URL access.
The host performs the replacement; conversation recovery still owns page-level
errors. Manual reset also falls back to the cached guest identity and saved tab URL
when native methods throw. Navigation updates retain the latest conversation URL;
the logical tab, profile, and sidebar entry survive every replacement.

Focused verification: 13 tests passed across `HostedBrowserWebview.test.tsx`,
`chatGPTBrowserHealth.test.ts`, and `webviewCrashRecovery.test.ts`. These cover the
OOM → launch-failed → destroyed sequence, missed early events, attachment failure,
manual reset of a destroyed guest, healthy loading, and unmount cancellation.
The web package typecheck passed. Targeted lint passed with two existing effect
dependency warnings. The tests use Node plus an explicit JSDOM fixture because
the shared setup's `node:sea` import fails under the automatic JSDOM environment.
This source change has not been loaded into the running desktop; no T3 restart or
deliberate crash of the user's live sessions was performed to verify it.

## Confirmed OOM recurrence and successful guest reset — 2026-10-26

The session **Message sending robustness**, ID
`4d256914-f11f-40c9-8bbd-88b9eb859fc0`, displayed white content at
`https://chatgpt.com/c/6ade7db7-e908-83ed-9c0f-0098b9487458`.
Unlike the first incident's memory-pressure hypothesis, renderer history confirms
out-of-memory failure for this exact sidebar session:

| Local time (Europe/Copenhagen, UTC+01:00) | WebContents | Event | Reason / exit code |
| --- | --- | --- | --- |
| 2026-10-26 01:11:10.025 | 7 | render-process-gone | crashed / -36861 |
| 2026-10-26 01:11:10.166 | 8 | render-process-gone | oom / -536870904 |
| 2026-10-26 01:11:10.384 | 8 | render-process-gone | launch-failed / 18 |
| 2026-10-26 01:11:10.422 | 8 | destroyed | — |

Evidence is in `.t3/userdata/logs/renderer-history.ndjson*`, scoped by the sidebar
session ID in `tabId`. The session-control recovery log showed **28 attempts**,
categorized as `load-failure`, ending in `refresh-failed`. Inspection reported
`loading` with no observed guest URL or `browser-unresponsive` category. This is a
gap in classification: native renderer death/launch failure does not necessarily
produce the sustained JavaScript timeout or blank DOM that the new detector expects.
A destroyed guest can reject inspection immediately and remain stuck Loading.

At 02:12:59 local time, the existing preview menu's **Reset browser instance** action
created WebContents **38** for the same sidebar session. Renderer history records
its `dom-ready` at 02:13:00.811, running in renderer PID `27416`. A screenshot and
session read verified the correct conversation and its visible message history.
The white-browser failure was recovered without restarting T3, deleting/replacing
the sidebar entry, clearing cookies, or sending a message. Desktop PID `50512`
and backend PID `44292` were retained during this intervention.

After the reset, ChatGPT displayed **Connection interrupted. Waiting for the complete
answer** (`stuck_connecting` / orange). This is a separate conversation-response
state, not a remaining white browser. No Stop, Continue, or message send was issued.

The machine had about 32.8 GiB free physical memory and 23.5 GiB free virtual/commit
capacity at inspection, so the earlier startup failure persisted after memory
pressure subsided. Replacing the guest, rather than another refresh, was sufficient
to load the page. Native `oom`/`launch-failed` evidence should be retained and routed
to instance-reset recovery even when DOM inspection is unavailable.

This report records the investigation requested for the sidebar session **ChatGPT 2**.
The original live recovery attempts did not restore it. Browser instance replacement
was subsequently implemented in source; its live result must be verified separately.

## Target and observed failure

- Sidebar session ID: `a0845b8f-f6db-4e5f-9d41-e9f31749f5d6`.
- Environment ID: `522cb823-71c8-4e9f-b668-dbe1faa9ec55`.
- Guest address: `https://chatgpt.com/`, with completely white content and a loading
  indicator near completion. No ChatGPT conversation UI or error panel appeared.
- The active desktop profile was `AppData/Roaming/t3code-custom`; the live T3 home
  was this checkout's `.t3`, not the stale user-home `.t3` runtime record.

Desktop session read/list requests returned `request-timeout: Outcome UNKNOWN`:
the request reached the renderer but its response was not received. Direct desktop
pipe attempts also timed out. These results do not establish whether a side effect
occurred and are not permission to repeat message sends.

At inspection time, saved recovery history had no red/orange episode or attempt for
this session. That describes the records, not a verified live health classification.

## Recovery attempts and their limits

Ordinary refresh, guest DevTools reload, and hiding/restoring the same sidebar entry
left the page white. Hiding/restoring did not establish that the guest WebContents
ID or process changed; it must not be described as successful instance replacement.

Guest and main-window DevTools were opened during diagnosis. No usable evaluation
context or successful JavaScript evaluation was obtained. The guest network panel
showed no requests following its reload action, but a broken inspector could explain
that result. It is not proof of a dead renderer. The guest inspector was closed;
the main inspector may have remained open at the end of that investigation.

No T3 restart or process termination was commanded. After the user observed what
looked like a restart, read-only checks found the same desktop PID `51556` and server
PID `34844`, with process lifetimes predating the attempts. That rules out a complete
restart of those processes during the checked interval; a renderer reload or crash
remains possible. The only recent logged main-window command found was
`toggleDevTools`. UI interaction stopped after that concern was raised.

Screenshot capture transiently raised `System.OutOfMemoryException`, and one shell
launch failed with `0xC0000142`. A later memory query showed roughly 21.5 GiB free
physical memory but only 4.4 GiB free virtual/commit capacity, with 42 T3 processes.
Resource pressure is a hypothesis, not a confirmed cause.

## Architectural findings

Conversation recovery depends on a saved `/c/<id>` identity and successful guest
inspection. A newly spawned blank homepage has no such identity. Navigation can
also stay Loading indefinitely, so a loading flag alone cannot distinguish normal
startup from this incident. The existing categories (`load-failure`, `interrupted`,
`delivery-timeout`) describe failures observed in a working ChatGPT document.

The browser guest has a separate lifetime from the durable sidebar session and the
logical preview tab. `HostedBrowserWebview` already replaces its keyed `<webview>`
after `render-process-gone`. Reusing that replacement mechanism allows a host-side
reset even when guest JavaScript cannot execute. Desktop registration already detaches
the replaced WebContents and restores the logical tab's settings for the new one.

## Implemented recovery model

The new `browser-unresponsive` category covers repeated blank-document observations
or inspection timeouts on the same ChatGPT guest and URL for at least 60 seconds.
A normal empty composer, visible login/challenge controls, navigation errors, and
transient startup are not sufficient evidence. A URL change clears stale evidence.

Visible sessions are considered before the saved-conversation gate. Automatic reset
uses the existing global 30-second and per-session 2-minute recovery cooldowns. It
handles a confirmed blank document, or a timed-out fresh homepage without a saved
conversation. A timed-out existing conversation requires an explicit manual reset;
unknown message delivery also prevents automatic replacement.

The preview menu's **Reset browser instance** action replaces the local desktop guest
while retaining the sidebar entry, logical tab, current URL, and browser profile.
This discards guest memory, including unsaved text and browser history; it does not
clear cookies or profile storage. Session-control `reload` with `force=true` uses
the same operation when inspection reports `browser-unresponsive`.

Reset completion means a different WebContents ID registered within 10 seconds.
It does **not** mean ChatGPT has loaded successfully. Logs distinguish requested,
attached, and unconfirmed resets; subsequent page inspection must verify recovery.
No browser reset calls the application reload/restart path.

This is an Electron guest operation. Streamed web/mobile browser surfaces do not
expose the local guest reset menu. No provider adapter or wire schema is changed.

## Verification boundary

The incident was observed in the live app. Source changes are checked with focused
tests and static checks; no live application restart or deployment is part of this
change. The original ChatGPT 2 session must not be reported as restored without
observing its replacement ID and a working ChatGPT page.
