import { describe, expect, it, beforeEach, afterEach, vi } from "vite-plus/test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { OpenRigFloatingWindow, clampFloatingGeometry, readFloatingGeometry } from "./OpenRigFloatingWindow";

const storage = new Map<string,string>();
let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  storage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    innerWidth: 1300, innerHeight: 800,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
});
afterEach(() => { if (renderer) act(() => renderer?.unmount()); renderer = null; vi.unstubAllGlobals(); });

describe("OpenRig nonmodal floating window", () => {
  it("clamps oversized and offscreen geometry and preserves the persisted preference independently", () => {
    const preferred = { left: 10_000, top: -400, width: 2100, height: 1000 };
    const clamped = clampFloatingGeometry(preferred, { width: 900, height: 600 }, { width: 360, height: 420 });
    expect(clamped).toEqual({ left: 8, top: 8, width: 884, height: 584 });
    storage.set("geometry", JSON.stringify(preferred));
    expect(readFloatingGeometry("geometry")).toEqual(preferred);
    storage.set("geometry", '{"top":"oops","width":800}');
    expect(readFloatingGeometry("geometry")).toBeNull();
  });

  it("does not act as a modal fullscreen shield and supports in-window Escape and reset", async () => {
    const escape = vi.fn();
    await act(async () => {
      renderer = create(<OpenRigFloatingWindow
        id="qa-test-window" label="Agent workspace" storageKey="geometry"
        defaultGeometry={() => ({ left: 200, top: 60, width: 850, height: 540 })}
        minSize={{ width: 360, height: 420 }} compactBelow={640}
        header={() => <div>Drag to move</div>}
        onEscape={escape}
      >{({compact}) => <p>{compact ? "Compact" : "Wide content"}</p>}</OpenRigFloatingWindow>);
    });
    const dialog = renderer!.root.findByProps({ "aria-label": "Agent workspace" });
    expect(dialog.props["aria-modal"]).toBe("false");
    expect(JSON.stringify(renderer!.toJSON())).toContain("Wide content");
    await act(async () => {
      dialog.props.onKeyDown({ key: "Escape", defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });
    expect(escape).toHaveBeenCalledTimes(1);
  });
});
