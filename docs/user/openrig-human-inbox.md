# Human inbox (desktop)

T3 Code can show human-directed OpenRig queue messages, mailbox entries and requests for decisions without switching away from a T3 session.

Open **Human inbox** above the ChatGPT sessions list. It opens a floating window over the main content area. Search or filter messages on the left; select a message to read it on the right. Reading messages does not resolve OpenRig tasks. Regular messages are read-only; **version 2 agent-authored human forms** can be answered here when the full OpenRig secure answer writer is active.

When a new message is detected, T3 briefly shows its sender and a short excerpt beside the inbox. Click the notice to read the complete message. The initial connection establishes a baseline, rather than presenting existing messages as new arrivals. Multiple arrivals in the same refresh are summarized in a single notice; updates are polled and may take a short time to appear.

Use the **Popups** and **Sound** controls in the inbox window to configure visual and audible alerts separately. **AISpeak** is optional and off by default. When enabled, T3 asks the installed local `B:\GDrive\Tools\13AITools\AISpeak\aispeak.py` helper to speak a preview of the newest arrival. AISpeak limits input to **20 words**; T3 also caps the preview to 160 characters. Speech works only on the Windows desktop that has the helper installed.

## Interactive answers

OpenRig queue items authored as `humanForm` version 2 may include one-of-many **buttons**, multi-select **checkboxes**, numeric **sliders**, explanatory **links**, and **images** with click-to-expand previews. Messages can also contain safe Markdown links and images. The form is read from OpenRig's **original durable queue record**, never generated from client guesses. Legacy body-embedded forms remain **preview/copy-only**: no client-side convention can impersonate a server-authorized decision.

Selections are **local drafts** until you explicitly press **Send answers**. The desktop sends the canonical version 2 answer payload directly to `POST /api/integrations/t3/human-inbox/:qitemId/answer`. The original queue validates option IDs, checkbox bounds, numeric step, recipient, pending state, and idempotent retries. A 503, conflict, or missing token is shown as **not submitted**, with the draft retained. After a confirmed reply, the UI reports **recorded in OpenRig's durable queue**, with the server's `queued`/`verified`/`indeterminate` delivery status; neither state asserts the agent has consumed it.

The action endpoint is **not** part of the Phase-1 bridge. It requires a full OpenRig daemon with its original queue writer and a separate secret (`OPENRIG_T3_HUMAN_ANSWER_TOKEN`, at least 24 characters) made available to **OpenRig and T3 desktop main/IPC**. The secret must **never** be placed in the renderer, web bundles, local storage or a message. Existing optional OpenRig integration bearer authorization still applies. Do not interpret the presence of a rendered form or a clickable choice as proof the write service is configured.

## Organizing the inbox

Right-click a message (or press **Shift+F10** with its row focused) to mark read/unread, archive locally, move to local trash, restore, or copy. There is also a **...** button in the message-detail footer. **Manage** above the list provides bulk actions: archive all loaded, archive all loaded read, move all loaded or all loaded read to local trash, and restore all loaded archived/trashed. Bulk trash requires confirmation. Archived and Trash each have their own selectable folder, and both support restoration.

**Archive and Trash are local to this T3 installation**, persisted across restarts and kept separate per human address and original message ID. OpenRig has no corresponding archive/delete endpoint yet: these operations do NOT delete original queue/mailbox records, cancel an agent request, or resolve a human decision. An item moved to Trash remains recoverable. Bulk actions are deliberately limited to **loaded** messages because OpenRig may return a truncated page; the UI never implies unseen messages were changed.

Read and unread indicators are stored **locally in this T3 installation**, not as OpenRig server-side receipts. The inbox reflects the original OpenRig queue and mailbox. If OpenRig is offline, the window identifies any previously loaded messages as last-synced, rather than treating an unavailable service as an empty inbox. The message list and badges describe loaded results only when the server reports a truncated page.

## Agent authoring contract

For the **OpenRig full queue service**, send an authenticated `POST /api/queue/create` with `destinationSession: "human@kernel"`, `humanIntent: "decision"`, a concise `summary`, a complete human-readable `body`, an `evidenceRef` and a **version 2** `humanForm`. Do not hide the request solely inside JSON; the body must remain understandable without widgets.

```json
{
  "destinationSession": "human@kernel",
  "humanIntent": "decision",
  "summary": "Approve the rollout",
  "body": "The candidate build passed CI. Choose which environment and features to enable.",
  "evidenceRef": "docs/release-readiness.md",
  "humanForm": {
    "version": 2,
    "title": "Rollout decision",
    "questions": [
      {
        "id": "environment",
        "type": "single-select",
        "prompt": "Which environment?",
        "options": [
          {"id": "staging", "label": "Staging"},
          {"id": "production", "label": "Production"}
        ]
      },
      {
        "id": "features",
        "type": "multi-select",
        "prompt": "Which features?",
        "minSelected": 1,
        "maxSelected": 2,
        "options": [
          {"id": "search", "label": "Search"},
          {"id": "metrics", "label": "Metrics"},
          {"id": "alerts", "label": "Alerts"}
        ]
      },
      {
        "id": "percentage",
        "type": "slider",
        "prompt": "Traffic percentage",
        "min": 0, "max": 100, "step": 5
      }
    ],
    "media": [
      {"type": "link", "url": "https://example.com/readiness", "label": "Readiness report"},
      {"type": "image", "url": "https://example.com/chart.png", "alt": "Rollout readiness chart"}
    ]
  }
}
```

This is **not** a general-purpose executable UI: authored form types are a small validated allowlist; no custom script, HTML or arbitrary actions execute. Legacy Slack `humanQuestions` retain their existing format and behavior. Use `single-select` for exclusive choices, `multi-select` when simultaneous options make sense, and `slider` only when a specific numeric bound and step are meaningful. V2 sliders intentionally require the operator to confirm a value rather than implicitly submitting the minimum.
