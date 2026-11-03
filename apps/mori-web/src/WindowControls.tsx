import { useEffect, useState } from "react";
import { nativeMori } from "./backend.ts";

// Frameless desktop windows render their caption controls in the same header as the web UI.
export function WindowControls() {
  const backend = nativeMori();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!backend) return;
    let mounted = true;
    const unsubscribe = backend.onWindowMaximized(value => {
      if (mounted) setMaximized(value);
    });
    void backend.windowIsMaximized().then(value => {
      if (mounted) setMaximized(value);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [backend]);

  if (!backend) return null;

  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button type="button" className="winbtn" aria-label="Minimize" title="Minimize" onClick={() => void backend.windowMinimize()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
      <button type="button" className="winbtn" aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"} onClick={() => void backend.windowToggleMaximize().then(setMaximized)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {maximized ? <><path d="M8 6V4h12v12h-2" /><rect x="4" y="8" width="12" height="12" rx="0.5" /></> : <rect x="5" y="5" width="14" height="14" rx="0.5" />}
        </svg>
      </button>
      <button type="button" className="winbtn close" aria-label="Close" title="Close" onClick={() => void backend.windowClose()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
    </div>
  );
}
