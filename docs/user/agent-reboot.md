# Agent Reboot versus browser reload

**Agent Reboot** creates a **new ChatGPT conversation** for the same OpenRig-managed AI agent. It reuses the existing T3 browser-session slot and preserves its title, hierarchy, project and recorded predecessor conversation link. It does **not** restart the T3 app, reload the old chat, or spawn a second root manager.

The operator command is `rig seat reboot <exact-seat-id>`; the OpenRig MCP action is `reboot_agent`. T3's internal desktop activation is `chatgpt.reboot`.

If the previous conversation is errored, T3 can proceed without reopening it _only_ when its failed page is positively known to contain no editable draft. If a message may still be sending, an unsaved draft cannot be ruled out, the browser identity differs, or the outcome is UNKNOWN, T3 refuses a destructive replacement. Reconcile the **original operation ID** rather than sending the reboot again.

Browser **reload/refresh** is a different recovery operation: it stays in the same ChatGPT conversation. In the session tooltip, **Last browser reload** and **Last Agent Reboot** are intentionally separate timestamps.

Compatibility: Older in-flight requests using the historical desktop activation name are accepted, and the pre-existing on-disk reboot journal retains its original storage key so unknown operations remain recoverable. New callers must use the Reboot name.
