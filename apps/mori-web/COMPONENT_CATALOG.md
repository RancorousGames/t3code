# T3 UI building blocks — Monku no Mori

**First read:** [MORI_PRODUCT_AND_UI_BRIEF_FOR_CLAUDE.md](MORI_PRODUCT_AND_UI_BRIEF_FOR_CLAUDE.md) for what the original Monku UI must enable and why the translator needs it. This catalog is only the reusable-component reference.

**For Claude's Monku design pass:** launch the Mori skeleton and select **T3 UI Kit** in the left sidebar. It shows interactive, **directly imported** T3 client components with real default appearance, supported variants, and their source file. The page source, `src/ComponentGallery.tsx`, is the quickest working usage reference.

**Boundaries:** Styling is intentionally limited to layout/spacing. Do not redesign the imported primitives or copy their JSX into `mori-web`. Instead compose them into Monku-specific views. Do **not** change `apps/web/src/components/ui` simply to achieve the Monku look; UI styling will be handled separately. These components are imported from the **existing T3 web client**, not locally reimplemented.

## Source imports

All available in **`apps/web/src/components/ui/`**. From a Monku source file in `apps/mori-web/src/`, the concrete import is:

```tsx
import { Button } from "../../web/src/components/ui/button";
import { Badge } from "../../web/src/components/ui/badge";
import { Input } from "../../web/src/components/ui/input";
```

Do not use `~/components/ui/...` from inside Mori source: that alias refers to T3 from inside T3 and the Mori app's tsconfig resolves it only for internal T3 component imports.

### Working live previews

| Live component | Original source | Relevant exports and design uses |
|---|---|---|
| Button | `button.tsx` | `Button` · `variant=default/secondary/outline/ghost/destructive`, `size=xs/sm/compact/default/lg/icon`. Toolbars and actions. |
| Badge | `badge.tsx` | `Badge` · `default/secondary/outline/info/success/warning/error/destructive`. Segment status and sync state. |
| Input | `input.tsx` | `Input` · `size=compact/sm/default/lg`. Metadata and search fields. |
| Input group | `input-group.tsx` | `InputGroup`, `InputGroupAddon`, `InputGroupInput`. Search icon and inline addons. |
| Textarea | `textarea.tsx` | `Textarea` · `size=sm/default/lg`. Curated translation, context, character descriptions. |
| Checkbox | `checkbox.tsx` | `Checkbox` · `checked`, `onCheckedChange`. Multi-select or configuration. |
| Switch | `switch.tsx` | `Switch` · `checked`, `onCheckedChange`. On/off preferences. |
| Radio buttons | `radio-group.tsx` | `RadioGroup`, `Radio`. Exclusive choices. |
| Select | `select.tsx` | `Select`, `SelectTrigger`, `SelectValue`, `SelectPopup`, `SelectItem`, `SelectGroup`, `SelectGroupLabel`. Filters and small selectors. |
| Segmented toggles | `toggle-group.tsx` | `ToggleGroup`, `Toggle`. Matrix column and status presets. |
| Table | `table.tsx` | `Table`, `TableHeader`, `TableBody`, `TableHead`, `TableRow`, `TableCell`. Small tabular metadata; Matrix virtualization is separate. |
| Alert | `alert.tsx` | `Alert`, `AlertTitle`, `AlertDescription`, `AlertAction`. Data safety and errors. |
| Dialog | `dialog.tsx` | `Dialog`, `DialogTrigger`, `DialogPopup`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `DialogPanel`. Confirmation/creation. |
| Popover | `popover.tsx` | `Popover`, `PopoverTrigger`, `PopoverPopup`. Inline glossary and context inspectors. |
| Collapsible | `collapsible.tsx` | `Collapsible`, `CollapsibleTrigger`, `CollapsiblePanel`. Inline metadata disclosure. |
| Separator | `separator.tsx` | `Separator`. Section delimiters. |
| Spinner | `spinner.tsx` | `Spinner`. **Actual** pending operations, not synthetic timers. |
| Skeleton | `skeleton.tsx` | `Skeleton`. Data-fetch placeholder. |
| Keyboard hints | `kbd.tsx` | `Kbd`, `KbdGroup`. Keyboard shortcuts. |

### Minimal composition examples

The gallery has runnable examples; here are the most useful API patterns:

```tsx
<Badge variant="warning">Draft</Badge>
<Button variant="outline" size="sm">Preview</Button>
<Switch checked={autosave} onCheckedChange={setAutosave} />
<Checkbox checked={includeLocked} onCheckedChange={value => setIncludeLocked(value === true)} />

<Select value={status} onValueChange={value => setStatus(value ?? "all")}>
  <SelectTrigger size="sm"><SelectValue placeholder="Status" /></SelectTrigger>
  <SelectPopup>
    <SelectItem value="all">All</SelectItem>
    <SelectItem value="draft">Draft</SelectItem>
  </SelectPopup>
</Select>
```

No custom variants, icons, tokens, shadow overrides, or restyling are used in the gallery. T3's `apps/web/src/index.css` supplies the base theme. The local `src/mori.css` is only structural.

## Used already in Monku's actual screens

- Shell: `Button`, `Popover` (project switcher, save state), `Alert` (file errors), `Dialog` (confirmations, new character, shortcuts), `Kbd`.
- Matrix/Focus toolbar: `InputGroup` search, `ToggleGroup` filters and density, `Select` speaker filter, `Checkbox` columns.
- Rows and inspector: `Textarea` (active line only), `Badge`, `Input`.
- The Matrix is a CSS grid of divs, not `Table`, so rows can use `content-visibility` and only the active row mounts an editor. True virtualization is still future work.
- Theme: `src/mori.css` overrides T3 semantic tokens on `html.dark.mori`; no T3 component is restyled.

## Worth considering later (requires context or extra dependencies)

These also exist in T3, but are **not** imported into this minimal standalone gallery:

| UI building block | Where to inspect | Why not drop-in immediately |
|---|---|---|
| Tooltip | `apps/web/src/components/ui/tooltip.tsx` | References T3 window-controls-overlay height context; pulling it in here drags unrelated desktop/ChatView types. Integration boundary needed. |
| Sidebars | `apps/web/src/components/ui/sidebar.tsx`, `apps/web/src/components/AppSidebarLayout.tsx` | T3 project/thread navigation and UI state. Could reuse primitives once its state is decoupled. |
| Toast / notifications | `apps/web/src/components/ui/toast.tsx` | Requires a host/provider, lifecycle, and UI notifications. |
| Rich chat UI | `apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/ChatComposer.tsx` | Full runtime, session state, provider capabilities, and app-specific route coupling. Do **not** fake or duplicate until T3 sessions are integrated. |
| Model/provider picker | `apps/web/src/components/chat/ProviderModelPicker.tsx` | Assumes live provider registry and T3 thread permissions. |
| Theme editing | `apps/web/src/components/settings/ThemeEditorHost.tsx` | Uses T3 settings/application state. Defer to styling phase. |
| Command palette | `apps/web/src/components/CommandPalette.tsx`, `components/ui/command.tsx` | Palette requires command registry and navigation. |
| Additional base primitives | `apps/web/src/components/ui/` | `sheet`, `menu`, `combobox`, `autocomplete`, `calendar`, `wizard`, `color-picker`, `scroll-area`, `label`, `input-group`, etc. Not necessary to import everything. |

## Build, test, packaging

From the T3 monorepo root, without changing normal T3 startup:

```powershell
node_modules/.bin/tsc.cmd -p apps/mori-web/tsconfig.json --noEmit
cd apps/mori-web
../../node_modules/.bin/vp.cmd build
node --experimental-strip-types --test src/model.test.ts
```

The independent Electron wrapper is `apps/mori-desktop`; it has its **own application ID, update channel (manual for now), and user profile**. Neither this gallery nor Monku is part of the developer's OpenRig management hierarchy for the wife's translation work.

## Design constraints for next agent

1. Preserve the Matrix / Streamliner / Characters / Glossary / Context workflow; use the actual T3 components demonstrated here.
2. Keep imported T3 controls on their provided variants/sizes. Prefer composition and Monku page layout over restyling controls.
3. Feel free to change **Monku layout**, visual hierarchy, information density and spacing. Leave the **functionality** and data-safety protections untouched.
4. Do not claim T3 chat/model selection works in Mori yet. The AI panel is a future integration.
5. Keep the new application's UI, project data, and update channel isolated from the developer's live T3 desktop application.
