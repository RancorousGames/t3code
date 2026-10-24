# Recovering embedded ChatGPT conversations

T3 Code keeps the original browser session and ChatGPT conversation when ChatGPT is busy, throttled, or temporarily unavailable. It does not create a replacement conversation or hand over your work as an automatic recovery step.

**Red (load failure):** T3 periodically checks the guest and refreshes only when the current page still identifies the original conversation and there is no running response or unsent draft. Retries use a fixed two-minute minimum per session, with at least 30 seconds between recovery actions globally. There is no retry limit or increasing wait.

**Orange (interrupted response):** T3 first allows approximately ten minutes for the connection to recover by itself. A **guarded reload** means refreshing the same verified conversation only after the error persists, the response is no longer actively generating, and the composer is safely empty. It never means starting a new chat.

If the same identifiable user turn remains interrupted after a reload, T3 may click **Stop** once, provided the Stop control is present and the generation is confirmed interrupted. Once the page is confirmed idle, T3 may send one literal **`Continue.`** message to resume that specific interrupted turn. “Once” refers to that verified turn, not the entire conversation: a different, later user turn can be recovered separately after its own grace period.

T3 records each Stop/Continue attempt before acting. If the result cannot be verified (including an unknown send receipt), it checks passively rather than repeating the action. It also leaves any unsent draft intact. Authentication, access, and conversation-length errors receive passive rechecks and diagnostics rather than a forced redirect or conversation handover.

The recovery status may remain queued while the guest is uninspectable. No terminal escalation or increasing backoff cancels its future checks.
