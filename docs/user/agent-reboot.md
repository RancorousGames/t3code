# Agent Reboot versus browser reload

**Agent Reboot** creates a **new ChatGPT conversation** for the same OpenRig-managed AI agent. It reuses the existing T3 browser-session slot and preserves its title, hierarchy, project and recorded predecessor conversation link. It does **not** restart the T3 app, reload the old chat, or spawn a second root manager.

The operator command is `rig seat reboot <exact-seat-id>`; the OpenRig MCP action is `reboot_agent`. T3's internal desktop activation is `chatgpt.reboot`.

Agent Reboot is explicitly allowed from **working, pending, stalled, errored, hidden or unloaded** sessions. T3 mounts the existing browser slot and starts a new ChatGPT conversation without waiting for the old conversation to become idle. The old URL and prior UNKNOWN delivery evidence are retained; an available private draft snapshot is attempted. **Forcing a reboot can interrupt active generation or lose an unreadable, unsent draft.** Reconcile the **original reboot operation ID** after an ambiguous outcome; never replay its initial send.

Browser **reload/refresh** is a different recovery operation: it stays in the same ChatGPT conversation. In the session tooltip, **Last browser reload** and **Last Agent Reboot** are intentionally separate timestamps.

Compatibility: Older in-flight requests using the historical desktop activation name are accepted, and the pre-existing on-disk reboot journal retains its original storage key so unknown operations remain recoverable. New callers must use the Reboot name.
