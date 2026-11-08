# Register a ChatGPT conversation created outside T3 Code

An existing ChatGPT conversation can be imported into the T3 sidebar without creating another ChatGPT conversation or sending a new prompt.

1. In the external ChatGPT conversation, call **OMCP Tools Bootstrap** with a role (and optional title). Copy the returned `[T3_ID:<uuid>]`.
2. **Send that marker in an assistant reply in the same conversation.** The marker must appear in the assistant's own message, not only in a user message or the tool result.
3. Call **OMCP Tools `t3_sessions`** with `action="register_external"`, `sessionId="<Bootstrap UUID>"`, and preferably `conversationUrl="https://chatgpt.com/c/<conversation UUID>"`. Optionally supply `proposedTitle`. Without a URL, T3 searches the signed-in profiles' ChatGPT history.
4. The registration request reports **queued**, not completed. After T3 verifies the exact assistant marker against the referenced conversation, it imports the tab. Call `t3_sessions(action="list", which="all", includeHidden=true)` to check that the public session ID and expected conversation are present.

The external conversation must be accessible to one of the ChatGPT accounts configured in T3. A guessed URL or another conversation's marker cannot register it. Verification uses an isolated, hidden history browser; it does not navigate or modify an existing T3 tab or its draft. Failed searches are retried for a bounded period and remain unregistered if verification never succeeds. A repeat request for an already imported session is idempotent; a conflicting URL is rejected. If T3 is offline, the request cannot be queued.
