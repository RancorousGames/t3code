# Native Chromium window embedding — failure investigation (2026-11-02)

## Scope

Investigated the earlier T3 native-child `SetParent` path after repeated regressions from the replacement DWM-thumbnail and floating always-on-top approaches. No production code changed during this investigation.

## Controlled tests

Two independent Electron 44 processes (not launched as managed, temporary test shells) were used. Source: `BaseWindow` containing a live `WebContentsView` with JavaScript heartbeat. Target: a separate `BrowserWindow` simulating T3. Both were per-monitor DPI-aware (`GetAwarenessFromDpiAwarenessContext = 2`), with 96 DPI in the test.

### 1. True native child using `SetParent`

- Target changes source window to `WS_CHILD`, calls `SetParent(sourceHWND, targetHWND)` and positions it within the target. The live source renderer continues executing during attachment.
- Forcibly killing the target with `Stop-Process -Force` initially leaves the source process and JavaScript heartbeat running. Electron's carrier may still report `isDestroyed() === false` after cross-process window destruction, so trusting that property is unsafe.
- Shortly after forced target destruction, the source Electron process **crashes natively** without a JavaScript `exit`, `closed` or `uncaughtException` callback. Windows Application Error events show electron.exe (v44.4.5) faults on matching source PIDs:
  - PID 29964 (0x750C), around 22:03:52/22:04:07 local time: `0x80000003` breakpoint followed by `0xC000041D` unhandled callback exception, both at `electron.exe + 0x35096a8`.
  - Earlier source PIDs 52768 and 50844 had the same native exception pattern.
- This reproduces the prior host-survival failure. It is a **native Electron crash**, not an ordinary `window-all-closed` exit, JavaScript lifecycle bug or simply a lost host pipe.
- Windows explicitly warns that cross-process `SetParent` can force a DPI-awareness reset if parent and child DPI modes differ; see Microsoft Win32 `SetParent` documentation. Our matched-DPI test still crashes, so DPI mismatch is not the sole explanation.
- Automatically recreating the carrier from JavaScript is not a sufficient fix if Electron aborts before a callback runs.

### 2. Top-level **owned** popup using `GWLP_HWNDPARENT`

- A separate test used `SetWindowLongPtrW(sourceHWND, GWLP_HWNDPARENT, targetHWND)` **without changing it into a WS_CHILD or calling SetParent**.
- Verified with `GetWindow(..., GW_OWNER)`: it references the target. Both processes continue to run and the original source Chromium document remains live.
- After forcibly killing target PID 58488, the Chromium source PID 51412 **remained running** and its original HWND was still valid. Later JavaScript heartbeats continued, with no corresponding new Windows crash event.
- Windows minimized the source popup after the owner died (`IsIconic == 1`, `WS_MINIMIZE` set). Calling `ShowWindow(SW_RESTORE)`, followed by `SetWindowPos`, restored the **same HWND** to visible size without reloading the DOM.
- A second target process PID 56820 adopted the **same source HWND**, and both remain running. The source was restored and positioned at (340,295), 440×265 inside the 530×350 target window at (300,250). Both are per-monitor DPI aware.
- This relationship is a **top-level owned window**, not genuine clipped native child embedding. It may substantially improve stacking and Alt-Tab compared with free-floating `HWND_TOPMOST`, but clipping, tooltip layering, focus, moving the owner and multi-monitor DPI still need acceptance.

## Outcome

The owned-window approach shipped. Do not redeploy `SetParent` on the Electron-owned carrier. See [the current design](detached-chromium-host-handover.md).

## Repro scripts (scratch, not deployed)

- `.t3/worker-artifacts/setparent-investigation-source.cjs`
- `.t3/worker-artifacts/setparent-investigation-target.cjs`
- `.t3/worker-artifacts/setparent-recovery-source.cjs`
- `.t3/worker-artifacts/setowner-investigation-target.cjs`
- `.t3/worker-artifacts/setparent-investigation-source.log`
- `.t3/worker-artifacts/setparent-recovery-source.log`
- `.t3/worker-artifacts/setowner-investigation.log`
