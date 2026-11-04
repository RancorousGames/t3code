import { useApp, type Screen } from "./app-context.ts";
import { useEffect, useState } from "react";
import { Icon } from "./Icons.tsx";
import { KeyCaps } from "./Overlays.tsx";
import { checkRow } from "./insights.ts";
import { keyLabel } from "./shortcuts.ts";
import type { SaveState } from "./store.ts";
import { nativeMori } from "./backend.ts";
import { WindowControls } from "./WindowControls.tsx";
import { tr, formatUi } from "./ui-localization.ts";

// The window has no menu bar: commands live in the search bar (Ctrl+K), keys are listed in F1,
// and every other action sits next to the thing it changes.

const VIEW_TITLES: Record<Screen, string> = {
  matrix: "Matrix",
  focus: "Focus",
  characters: "Characters",
  glossary: "Glossary",
  context: "Context",
  project: "Project & files",
  settings: "Settings",
  chatgpt: "AI Chats",
};

export function Titlebar() {
  const { project, screen, view, bindings, openModal, go } = useApp();
  const [googleConnected, setGoogleConnected] = useState(false);
  useEffect(() => {
    let mounted = true;
    const refresh = () => { void nativeMori()?.googleStatus().then(status => {
      if (mounted) setGoogleConnected(status.connected);
    }).catch(() => { if (mounted) setGoogleConnected(false); }); };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("mori:google-state", refresh);
    return () => {
      mounted = false; window.removeEventListener("focus", refresh);
      window.removeEventListener("mori:google-state", refresh);
    };
  }, []);
  const viewTitle = screen === "matrix" && view.filter === "warnings" ? "Review" : VIEW_TITLES[screen];
  return (
    <header className="titlebar">
      <div className="tb-left">
        <div className="logo"><Icon name="tree" /></div>
        <div className="crumb">
          <b>{project.name}</b>
          <Icon name="chevron-right" size="xs" />
          <span className={view.file ? "" : "cur"}>{tr(viewTitle)}</span>
          {view.file && (
            <>
              <Icon name="chevron-right" size="xs" />
              <span className="cur">{view.file}</span>
            </>
          )}
        </div>
      </div>
      <button type="button" className="cmd" onClick={() => openModal({ kind: "palette" })}>
        <Icon name="search" size="sm" />
        <span>{tr("Search lines, characters, actions…")}</span>
        {bindings.palette && <KeyCaps binding={bindings.palette} />}
      </button>
      <div className="tb-right">
        <button type="button" className="sync" onClick={() => {
          go("settings");
          requestAnimationFrame(() => document.getElementById("mori-google-workspace")?.scrollIntoView({ behavior: "smooth", block: "center" }));
        }}>
          <span className={googleConnected ? "ldot" : "ldot off"} />
          Google Workspace · {googleConnected ? "connected" : "not connected"}
        </button>
        <WindowControls />
      </div>
    </header>
  );
}

const saveLabel = (save: SaveState): { text: string; color: string } => {
  switch (save.kind) {
    case "saving": return { text: tr("Saving…"), color: "var(--lantern)" };
    case "saved": return { text: formatUi("Saved {0} · {1}", [tr(nativeMori() ? "on this PC" : "in this browser"), new Date(save.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })]), color: "var(--moss)" };
    case "error": return { text: tr("Not saved · see the notice above"), color: "var(--berry)" };
    case "idle": return { text: nativeMori() ? "Stored locally on this PC · not synced" : "Stored in this browser · not synced to Google", color: "var(--moss)" };
  }
};

export function StatusBar() {
  const { project, save, activeRow, bindings, openModal, prefs } = useApp();
  const character = prefs.charactersEnabled && activeRow && project.characters.find(c => c.id === activeRow.characterId);
  const warnings = activeRow ? checkRow(activeRow, prefs.glossaryEnabled ? project.glossary : []).length : 0;
  const label = saveLabel(save);
  return (
    <>
      <footer className="statusbar">
        <span className="sb"><span className="ldot" style={{ background: label.color }} />{label.text}</span>
        {activeRow && (
          <>
            <span className="sb"><b className="mono">{activeRow.id}</b>{character && ` · ${character.name}`}</span>
            <span className="sb tabnum">{[...activeRow.final].length} chars · source {activeRow.source.length}</span>
          </>
        )}
        {warnings > 0 && <span className="sb warn"><Icon name="alert" size="xs" />{warnings} warning{warnings > 1 ? "s" : ""} on this line</span>}
        <span className="grow" />
        <span className="sb">{prefs.jaFont}</span>
        <button type="button" className="sbb" onClick={() => openModal({ kind: "shortcuts" })}>
          <Icon name="keyboard" size="sm" />
          {tr("Shortcuts")}
          {bindings.shortcuts && <span className="kbd">{keyLabel(bindings.shortcuts)}</span>}
        </button>
      </footer>
    </>
  );
}
