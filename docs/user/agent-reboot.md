# Agent Reboot versus browser reload

**Agent Reboot** creates a **new ChatGPT conversation** for any existing T3 ChatGPT session, whether or not it belongs to an OpenRig agent. It reuses the existing T3 browser-session slot and preserves its title, hierarchy, project and recorded predecessor conversation link. It does **not** restart the T3 app, reload the old chat, or spawn a second root manager.

The operator command for managed agents is `rig seat reboot <exact-seat-id>`; OpenRig only tracks the stable seat, T3 session ID and reboot generation. **OpenRig is not required:** a standalone T3 session can invoke `node scripts/reboot-chatgpt-session.mjs --session-id <T3_UUID> --message-file <handoff.txt>` or identify itself by `--conversation-url https://chatgpt.com/c/<uuid>` instead of `--session-id`. T3's internal desktop activation is `chatgpt.reboot`.

Agent Reboot is explicitly allowed from **working, pending, stalled, errored, hidden or unloaded** sessions. T3 mounts the existing browser slot and starts a new ChatGPT conversation without waiting for the old conversation to become idle. The old URL and prior UNKNOWN delivery evidence are retained; an available private draft snapshot is attempted. **Forcing a reboot can interrupt active generation or lose an unreadable, unsent draft.** Reconcile the **original reboot operation ID** after an ambiguous outcome; never replay its initial send.

Browser **reload/refresh** is a different recovery operation: it stays in the same ChatGPT conversation. In the session tooltip, **Last browser reload** and **Last Agent Reboot** are intentionally separate timestamps.

**Self-reboot:** A ChatGPT agent that can execute the T3 CLI can reboot its own conversation by writing a concise handoff and supplying its *verified* current T3 session ID or ChatGPT URL. Never infer its own identity from the selected/most recent T3 tab. The CLI prints the immutable reboot request ID before the operation. A `submitted` receipt means the new ChatGPT user turn was observed; `committed` requires a subsequent verified assistant response. Reconcile via `--session-id <T3_UUID> --request-id <ID> --phase status|finalize`; never reissue `begin` on an UNKNOWN response. See `C:/Users/crovea/.agents/skills/t3-agent-reboot/SKILL.md`.

Compatibility: Older in-flight requests using the historical desktop activation name are accepted, and the pre-existing on-disk reboot journal retains its original storage key so unknown operations remain recoverable. New callers must use the Reboot name.
