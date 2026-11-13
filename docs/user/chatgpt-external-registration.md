# Import a ChatGPT conversation created outside T3 Code

T3 can attach an existing phone/browser ChatGPT conversation without creating a second conversation, submitting prompts, focusing another tab or touching composer drafts.

1. In the external ChatGPT conversation, call **OMCP Tools Bootstrap**, then send its exact `[T3_ID:<uuid>]` marker as an **assistant reply in that same conversation** (not merely a tool result or user quote).
2. Bootstrap automatically queues discovery in T3. After about 30 seconds T3 scans recent chats first, then searches the authenticated ChatGPT history in its configured profiles. It only attaches a URL after finding the exact marker in an assistant reply. It will not guess from titles or Bootstrap UUIDs.
3. Check `t3_sessions(action="list", which="all", includeHidden=true)` for the Bootstrap public ID and the matching `https://chatgpt.com/c/<conversation UUID>` URL.
4. If missing, call `t3_sessions(action="external_status", sessionId="<Bootstrap UUID>")` to read whether import is pending, failed or attached, with retry count and last diagnostic. An error notification also appears in T3 after eight unsuccessful attempts. You can retry explicitly using `action="register_external"` and, preferably, the exact `conversationUrl` from the original ChatGPT browser.

Only a conversation accessible to a signed-in ChatGPT profile in T3 can be imported. An already attached session is reused, including hidden or snoozed sessions. Ambiguous matches, missing markers and inaccessible profiles fail closed. Imported chats do not trigger an assistant or user message. A T3/OMCP build predating this feature may need a **user-authorized** update/restart; Bootstrap cannot import while T3 is offline.
