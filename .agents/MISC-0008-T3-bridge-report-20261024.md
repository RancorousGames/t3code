# MISC-0008 T3 bridge report: TaskBoard review gates (2026-10-24)

Worker: Claude Opus 5.5 (Claude Code), finite run. No child agents, no commits, no restart, no rebuild.

## Status: IMPLEMENTED, NOT VERIFIED BY TOOLS

- The code is written and I reviewed it by hand.
- Tests and typecheck did **not** run. The harness needs interactive approval for `vp` (and for `node node_modules/vite-plus/bin/vp`), and this session can't grant it. I stopped instead of finding another way to run them.
- Run these first:
  - `vp test run apps/desktop/src/ipc/methods/openRigReviewGate.test.ts apps/desktop/src/ipc/methods/openRigOperatorReply.test.ts`
  - typecheck for `apps/desktop`, `apps/web` and `packages/contracts`

## Sources

- Read: both AGENTS.md files and the brief.
- **Permission denied** (outside the repo):
  - `B:/GDrive/.../MISC-0008.md`
  - `D:/SSDProjects/Tools/OpenRig/packages/daemon/src/**`
  - `D:/SSDProjects/Tools/OpenRig/.openrig-omni-dev/reports/misc-0008-integration-report-20261024.md`
- So everything follows the contract in the brief. Where the brief gave no wire shape, I assumed one (listed below). Any mismatch fails closed: nothing is sent and the UI shows not_sent or unknown.

## Files changed (T3 only; nothing foreign touched)

- `packages/contracts/src/ipc.ts`:
  - optional `reviewGate: Unknown` on `DesktopOpenRigInboxItemSchema`
  - `OPENRIG_REVIEW_GATE_VERDICTS`, `OpenRigReviewGate`, `safeOpenRigReviewUrl`, `decodeOpenRigReviewGate` (strict, fail-closed)
  - selection / resolve input / result schemas
  - 3 optional `DesktopBridge` methods
- `apps/desktop/src/ipc/methods/openRig.ts`:
  - `postOpenRigReviewGateResolve`, `lookupOpenRigReviewGateReceipt`, `openOpenRigReviewGateUrl`
  - IPC methods `resolveOpenRigReviewGate` (native confirmation dialog), `reconcileOpenRigReviewGate`, `openOpenRigReviewGate` (`ElectronShell.openExternal`)
- `apps/desktop/src/ipc/channels.ts`, `apps/desktop/src/preload.ts`, `apps/desktop/src/ipc/installOpenRigIpcHandlers.ts`: 3 channels plus wiring.
- `apps/web/src/components/sidebar/OpenRigReviewGatePanel.tsx` (new): thumbnail, title, review/revision, gate state badge, **Open review**, verdict choice, optional note, **Release gate…**, and an unknown-outcome banner with **Check status** and **Dismiss**.
- `apps/web/src/components/sidebar/OpenRigOperatorInbox.tsx`:
  - renders the panel above the message body
  - hides the "no native approval form" banner when a valid review gate is present (otherwise that label would be wrong)
- `apps/desktop/src/ipc/methods/openRigReviewGate.test.ts` (new): focused tests.
- `docs/user/openrig-human-inbox.md`: short "TaskBoard review gates" section.

Uncommitted changes that were already present are untouched:
- `chatGPTBrowserSessions.ts`, `DesktopAppActivationCoordinator.tsx`, `desktopAppActivation*`, `scripts/chatgpt-sessions*`, `chatGPTRolloverFinalize*`
- `.claude/worktrees/`, and the `.agents` brief/stdout/stderr files

## Security model as built

- **Secret stays in MAIN.**
  - MAIN loads it with the existing `privateOperatorAnswerToken()` / `operatorReplyHeaders()`: env `OPENRIG_T3_HUMAN_ANSWER_TOKEN`, then a fallback to `~/.openrig/operator-tokens/t3-human-answer-token.txt`. An explicitly blank env value disables the fallback.
  - Headers sent: `x-openrig-human-answer-token`, `x-openrig-human-intent: t3-desktop-ipc`, plus the optional ordinary `Authorization: Bearer`. No Origin or forwarded-for header is set.
  - The endpoint is fixed at `127.0.0.1:7433`.
  - The renderer never sees the token.
- **The renderer is not trusted.** It only names `{destination: human@kernel, qitemId, gateQitemId}` plus review/revision/verdict/requestId/note. Before any POST, MAIN:
  1. Re-reads the operator inbox itself. Exactly one item must match `id` with `recipient === human@kernel`, and its `reviewGate` must decode with the same `gateQitemId`.
  2. Requires gate `status: "pending"` and matching `reviewId` and `reviewRevision`. If TaskBoard already recorded a verdict, the submitted verdict must equal it.
  3. Confirms the binding via the bearer-protected link GET: exactly one link for this gate, with the same reviewId and revision.
  4. Shows a **native MAIN dialog**: Cancel (default) / Release gate. It lists the verdict, review, revision, gate and note. An IPC call alone is never treated as human intent. Cancel, or a dialog error, returns `cancelled` and nothing is sent.
- **No duplicate writes.**
  - Once the POST starts, any error, timeout or non-matching 2xx leads only to a read-only `GET /:gate/receipts/:requestId`.
  - A second POST never happens.
  - The renderer saves `requestId` in localStorage *before* invoking, so after a crash it can only reconcile.
  - **Dismiss** clears that local record so the user isn't stuck. A later release still has to pass MAIN's `status === "pending"` check.
- **Receipt.**
  - `gateReleased: true` is the durable release.
  - `wake` is reported separately (`delivered | queued | indeterminate | failed | not_attempted`), and the UI words them differently.
- **Open review.**
  - The renderer never sends a URL. MAIN re-reads the item and opens only a credential-free loopback `http(s)` URL (`localhost`, `127.0.0.1`, `[::1]`). The shell's own safe-URL check then runs too.
  - `javascript:`, `file:`, off-host and credentialed URLs are rejected.
  - Thumbnails: loopback `http(s)` or bounded `data:image/(png|jpeg|webp);base64`. A thumbnail that fails to load is hidden.
- **The ordinary queue reply is unchanged** and is not used as a gate path.
- **No automatic TaskBoard → gate release callback.** There is no trusted TaskBoard process provenance in T3, so this stays fail-closed, and the UI and docs say so.

## Assumed wire shapes (verify against OpenRig)

1. Inbox item field `reviewGate`:
   `{gateQitemId:"qitem-…", reviewId:[A-Za-z0-9._:-]{1,128}, reviewRevision:int≥1, status:"pending"|"released", title?, reviewUrl?, thumbnailUrl?, verdict?: null|"approved"|"changes_requested"|"rejected"}`.
   If OpenRig's `/api/integrations/t3/human-inbox` doesn't provide this field, the panel never renders and MAIN refuses every call.
2. Link GET: `GET /api/integrations/taskboard-review-gates?gateQitemId=<id>` returns `[...]` or `{links:[...]}`, each item having `gateQitemId, reviewId, reviewRevision`.
3. Resolve POST: `/api/integrations/taskboard-review-gates/:gateQitemId/resolve` with body `{version:1, requestId, reviewId, reviewRevision, verdict, note?}` (as in the brief).
   - Success receipt: `{version:1, requestId, gateQitemId, reviewId, reviewRevision, verdict, status:"recorded"|"idempotent", gateReleased:true, wake}`.
   - Decline: non-2xx with `{outcome:"not_sent", error}`.
4. Receipt GET: `/:gateQitemId/receipts/:requestId` returns the same receipt. A 404 with `{outcome:"unconfirmed"}` means not yet known.

## Tests written (not run)

`openRigReviewGate.test.ts`:
- URL validation: rejects javascript, off-host, credentialed and file URLs.
- Malformed gate bindings decode to no gate.
- A missing secret means no network call at all.
- Forged selections are refused with 0 POSTs and no dialog: wrong gate, wrong revision, item not in inbox, already released, recorded-verdict mismatch, foreign recipient, link revision mismatch.
- Native cancel sends nothing.
- Exact POST body and headers (no Origin or forwarded-for).
- A lost acknowledgement leads to 1 POST plus 1 GET with an idempotent receipt.
- A spoofed 2xx gives unknown, with no re-POST.
- Repeated reconciliation is read-only and stable.
- Native routing opens only the URL MAIN re-read; hostile or forged selections open nothing.

## Not done / follow-ups

- Run the tests and typecheck (blocked here, see above), and run the formatter. A few test lines may go over the formatter's width.
- Confirm the assumed shapes against OpenRig's `taskboard-review-gates.ts` and the human-inbox projection, then adjust field names if needed.
- Desktop rebuild and restart are left to the user; per the brief, nothing was restarted.
- Web (non-desktop) and mobile clients: there is no `desktopBridge` there, so the panel shows nothing actionable. That matches the existing Human Inbox, which is desktop-only.
