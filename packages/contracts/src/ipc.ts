import * as Schema from "effect/Schema";

import { SnapShotSource } from "./chatAttachment.ts";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";
import type {
  BrowserImportResult,
  BrowserImportSource,
  BrowserImportSourceId,
} from "./browserImport.ts";
import { AuthAccessTokenResult, AuthSessionState, AuthWebSocketTicketResult } from "./auth.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { type ClientSettings, type QuitConfirmationMode, SnapShotShortcut } from "./settings.ts";
import type { EditorId } from "./editor.ts";
import type { PreviewForwardedShortcut } from "./keybindings.ts";

import type {
  DesktopAppActivationRequest,
  DesktopAppActivationResponse,
} from "./desktopAppActivation.ts";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  /** Renders as a non-interactive section header label. Web fallback only — stripped on desktop native menus. */
  header?: boolean;
  /** Icon keyword resolved by the web fallback. Stripped on desktop native menus. */
  icon?: string;
  /** Inserts a visual section divider immediately before this item. */
  separatorBefore?: boolean;
  /** Shows a check mark. Used to mark the current option inside a submenu. */
  checked?: boolean;
  children?: readonly ContextMenuItem<T>[];
}

export type QuitShortcutHintEvent =
  | { readonly state: "down"; readonly mode: Exclude<QuitConfirmationMode, "direct"> }
  | { readonly state: "up" };

export interface ContextMenuItemSchemaType {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly header?: boolean;
  readonly icon?: string;
  readonly separatorBefore?: boolean;
  readonly checked?: boolean;
  readonly children?: readonly ContextMenuItemSchemaType[];
}

export const ContextMenuItemSchema: Schema.Codec<ContextMenuItemSchemaType> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  header: Schema.optionalKey(Schema.Boolean),
  icon: Schema.optionalKey(Schema.String),
  separatorBefore: Schema.optionalKey(Schema.Boolean),
  checked: Schema.optionalKey(Schema.Boolean),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.suspend((): Schema.Codec<ContextMenuItemSchemaType> => ContextMenuItemSchema),
    ),
  ),
});

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";
export type DesktopUpdateChannel = "latest" | "nightly";
export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";

export const DesktopUpdateStatusSchema = Schema.Literals([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
export const DesktopRuntimeArchSchema = Schema.Literals(["arm64", "x64", "other"]);
export const DesktopThemeSchema = Schema.Literals(["light", "dark", "system"]);
export const DesktopUpdateChannelSchema = Schema.Literals(["latest", "nightly"]);
export const DesktopAppStageLabelSchema = Schema.Literals(["Alpha", "Dev", "Nightly"]);

export interface DesktopAppBranding {
  baseName: string;
  stageLabel: DesktopAppStageLabel;
  displayName: string;
}

export const DesktopAppBrandingSchema = Schema.Struct({
  baseName: Schema.String,
  stageLabel: DesktopAppStageLabelSchema,
  displayName: Schema.String,
});

export const DesktopSnapShotMode = Schema.Literals(["direct", "portal", "unavailable"]);
export type DesktopSnapShotMode = typeof DesktopSnapShotMode.Type;

export const DesktopCaptureExtensionState = Schema.Struct({
  status: Schema.Literals([
    "not-installed",
    "disabled",
    "enabled",
    "restart-required",
    "update-required",
    "extensions-disabled",
    "unsupported",
    "error",
  ]),
  message: Schema.String,
});
export type DesktopCaptureExtensionState = typeof DesktopCaptureExtensionState.Type;

export const DesktopCaptureHelperState = Schema.Struct({
  status: Schema.Literals(["not-installed", "update-required", "ready", "error"]),
  message: Schema.String,
  feedbackAvailable: Schema.optional(Schema.Boolean),
});
export type DesktopCaptureHelperState = typeof DesktopCaptureHelperState.Type;

export const DesktopSnapShotSetupAction = Schema.Literals([
  "install-extension",
  "enable-extension",
  "disable-extension",
  "install-kde-helper",
  "remove-kde-helper",
  "install-hyprland-helper",
  "remove-hyprland-helper",
  "test-mac-capture",
  "allow-screen-recording",
  "allow-accessibility",
  "retry-shortcut",
]);
export type DesktopSnapShotSetupAction = typeof DesktopSnapShotSetupAction.Type;

export const DesktopCaptureConfigRequest = Schema.Struct({
  operation: Schema.Literals(["install", "remove"]),
  chooseFile: Schema.Boolean,
  shortcut: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
});
export type DesktopCaptureConfigRequest = typeof DesktopCaptureConfigRequest.Type;

export const DesktopCaptureConfigPreview = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  resolvedPath: Schema.String,
  before: Schema.String,
  after: Schema.String,
  shortcut: Schema.String,
  operation: Schema.Literals(["install", "remove"]),
});
export type DesktopCaptureConfigPreview = typeof DesktopCaptureConfigPreview.Type;

export const DesktopCaptureConfigApplied = Schema.Struct({
  backupPath: Schema.NullOr(Schema.String),
  warning: Schema.NullOr(Schema.String),
});
export type DesktopCaptureConfigApplied = typeof DesktopCaptureConfigApplied.Type;

export const DesktopSnapShotState = Schema.Struct({
  mode: DesktopSnapShotMode,
  windows: Schema.optional(Schema.Boolean),
  linuxDesktop: Schema.optional(Schema.Literals(["gnome", "kde", "niri", "hyprland"])),
  linuxBackend: Schema.optional(
    Schema.Literals(["screenshot-portal", "gnome-extension", "niri", "kde", "hyprland", "picker"]),
  ),
  linuxFeedbackAvailable: Schema.optional(Schema.Boolean),
  shortcut: SnapShotShortcut,
  shortcutRegistered: Schema.Boolean,
  shortcutPending: Schema.optional(Schema.Boolean),
  shortcutCanRetry: Schema.optional(Schema.Boolean),
  shortcutLabel: Schema.optional(Schema.String),
  shortcutMessage: Schema.NullOr(Schema.String),
  shortcutBinding: Schema.optional(Schema.String),
  shortcutConfigPath: Schema.optional(Schema.String),
  shortcutActionRegistered: Schema.optional(Schema.Boolean),
  gnomeExtension: Schema.optional(DesktopCaptureExtensionState),
  kdeHelper: Schema.optional(DesktopCaptureHelperState),
  hyprlandHelper: Schema.optional(DesktopCaptureHelperState),
  macPermissions: Schema.optional(
    Schema.Struct({ screenRecording: Schema.Boolean, accessibility: Schema.Boolean }),
  ),
  shortcutVerified: Schema.optional(Schema.Boolean),
  message: Schema.NullOr(Schema.String),
});
export type DesktopSnapShotState = typeof DesktopSnapShotState.Type;

export const DesktopSnapShotShortcutAvailability = Schema.Struct({
  available: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
});
export type DesktopSnapShotShortcutAvailability = typeof DesktopSnapShotShortcutAvailability.Type;

export const DesktopSnapShotId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-f0-9-]+$/i),
);
export type DesktopSnapShotId = typeof DesktopSnapShotId.Type;

/** Main-process capture lifecycle pushes. `id` is absent for failures before a capture exists. */
export const DesktopSnapShotEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("requested"), id: DesktopSnapShotId }),
  Schema.Struct({ type: Schema.Literal("started"), id: DesktopSnapShotId }),
  Schema.Struct({ type: Schema.Literal("ready"), id: DesktopSnapShotId }),
  Schema.Struct({ type: Schema.Literal("failed"), id: Schema.optional(DesktopSnapShotId) }),
  Schema.Struct({ type: Schema.Literal("shortcut-changed") }),
]);
export type DesktopSnapShotEvent = typeof DesktopSnapShotEvent.Type;

export const DesktopPendingSnapShot = Schema.Struct({
  id: DesktopSnapShotId,
  name: Schema.String,
  mimeType: Schema.Literal("image/png"),
  sizeBytes: Schema.Int,
  source: SnapShotSource,
});
export type DesktopPendingSnapShot = typeof DesktopPendingSnapShot.Type;

export const DesktopSnapShot = Schema.Struct({
  ...DesktopPendingSnapShot.fields,
  dataUrl: Schema.String,
});
export type DesktopSnapShot = typeof DesktopSnapShot.Type;

export const DesktopSnapShotAnimationDestination = Schema.Struct({
  id: DesktopSnapShotId,
  viewportFrame: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
  backgroundColor: Schema.String,
  borderColor: Schema.String,
  borderWidth: Schema.Number,
  cornerRadius: Schema.Number,
  details: Schema.optional(
    Schema.Struct({
      appName: SnapShotSource.fields.appName,
      windowTitle: SnapShotSource.fields.windowTitle,
      appIconDataUrl: SnapShotSource.fields.appIconDataUrl,
    }),
  ),
});
export type DesktopSnapShotAnimationDestination = typeof DesktopSnapShotAnimationDestination.Type;

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote>;
  omittedReleaseCount: number;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateReleaseNote {
  version: string;
  items: ReadonlyArray<string>;
  totalItems: number;
}

export const DesktopUpdateReleaseNoteSchema = Schema.Struct({
  version: Schema.String,
  items: Schema.Array(Schema.String),
  totalItems: Schema.Number,
});

export const DesktopUpdateStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  status: DesktopUpdateStatusSchema,
  channel: DesktopUpdateChannelSchema,
  currentVersion: Schema.String,
  hostArch: DesktopRuntimeArchSchema,
  appArch: DesktopRuntimeArchSchema,
  runningUnderArm64Translation: Schema.Boolean,
  availableVersion: Schema.NullOr(Schema.String),
  downloadedVersion: Schema.NullOr(Schema.String),
  releaseNotes: Schema.Array(DesktopUpdateReleaseNoteSchema),
  omittedReleaseCount: Schema.Number,
  downloadPercent: Schema.NullOr(Schema.Number),
  checkedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  canRetry: Schema.Boolean,
});

/** The desktop app's `t3` command on PATH, managed from Settings. */
export const DesktopCliCommandStateSchema = Schema.Struct({
  /** Only installed builds have a launcher to put on PATH. */
  supported: Schema.Boolean,
  /** The `t3` the app installed, or null when it is not installed. */
  installedPath: Schema.NullOr(Schema.String),
  /** Whether a new terminal finds it; false when the folder is not on PATH yet. */
  onPath: Schema.Boolean,
  /**
   * Another `t3` a new terminal runs instead, earlier on PATH. Install refuses
   * while it is there, since a link behind it would never run.
   */
  shadowedBy: Schema.optionalKey(Schema.String),
});
export type DesktopCliCommandState = typeof DesktopCliCommandStateSchema.Type;

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateActionResultSchema = Schema.Struct({
  accepted: Schema.Boolean,
  completed: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateCheckResultSchema = Schema.Struct({
  checked: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});

// Stable id for the Windows-native primary backend. Desktop side wraps
// this with a brand inside DesktopBackendManager; web side keeps it as
// a plain string so the env-runtime can compare against it without
// importing brand machinery from the desktop package.
export const PRIMARY_LOCAL_ENVIRONMENT_ID = "primary";

export interface DesktopEnvironmentBootstrap {
  // Stable backend instance id (e.g. "primary" or "wsl:ubuntu"). The
  // web env runtime keys local environments off this so projects
  // routed to a specific backend reopen against the same one.
  id: string;
  label: string;
  // Concrete WSL distro used by the current backend run. This stays separate
  // from id because a default-tracking instance keeps the stable
  // "wsl:default" IPC target while each run launches a specific distro.
  runningDistro?: string | null;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  bootstrapToken?: string;
}

export const DesktopEnvironmentBootstrapSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  runningDistro: Schema.optionalKey(Schema.NullOr(Schema.String)),
  httpBaseUrl: Schema.NullOr(Schema.String),
  wsBaseUrl: Schema.NullOr(Schema.String),
  bootstrapToken: Schema.optionalKey(Schema.String),
});

export const DesktopSshEnvironmentTargetSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
});
export type DesktopSshEnvironmentTarget = typeof DesktopSshEnvironmentTargetSchema.Type;

export type DesktopSshHostSource = "ssh-config" | "known-hosts";
export const DesktopSshHostSourceSchema = Schema.Literals(["ssh-config", "known-hosts"]);

export interface DesktopDiscoveredSshHost extends DesktopSshEnvironmentTarget {
  source: DesktopSshHostSource;
}

export const DesktopDiscoveredSshHostSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  source: DesktopSshHostSourceSchema,
});

export interface DesktopSshEnvironmentBootstrap {
  target: DesktopSshEnvironmentTarget;
  httpBaseUrl: string;
  wsBaseUrl: string;
  pairingToken: string | null;
  remotePort?: number;
  remoteServerKind?: "external" | "managed";
}

export const DesktopSshEnvironmentBootstrapSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  pairingToken: Schema.NullOr(Schema.String),
  remotePort: Schema.optionalKey(Schema.Number),
  remoteServerKind: Schema.optionalKey(Schema.Literals(["external", "managed"])),
});

export interface DesktopSshPasswordPromptRequest {
  requestId: string;
  destination: string;
  username: string | null;
  prompt: string;
  expiresAt: string;
}

export const DesktopSshPasswordPromptCancelledType = "ssh-password-prompt-cancelled" as const;

export const DesktopSshPasswordPromptCancelledResultSchema = Schema.Struct({
  type: Schema.Literal(DesktopSshPasswordPromptCancelledType),
  message: Schema.String,
});

export const DesktopSshEnvironmentEnsureOptionsSchema = Schema.Struct({
  issuePairingToken: Schema.optionalKey(Schema.Boolean),
});

export const DesktopSshEnvironmentEnsureInputSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  options: Schema.optionalKey(DesktopSshEnvironmentEnsureOptionsSchema),
});

export const DesktopSshEnvironmentEnsureResultSchema = Schema.Union([
  DesktopSshEnvironmentBootstrapSchema,
  DesktopSshPasswordPromptCancelledResultSchema,
]);

export const DesktopSshHttpBaseUrlInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
});

export const DesktopSshBearerRequestInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  bearerToken: Schema.String,
});

export const DesktopSshBearerBootstrapInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  credential: Schema.String,
});

export const DesktopSshPasswordPromptResolutionInputSchema = Schema.Struct({
  requestId: Schema.String,
  password: Schema.NullOr(Schema.String),
});

export const PersistedSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  wsBaseUrl: Schema.String,
  httpBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(DesktopSshEnvironmentTargetSchema),
  relayManaged: Schema.optionalKey(
    Schema.Struct({
      relayUrl: Schema.String,
    }),
  ),
});
export type PersistedSavedEnvironmentRecord = typeof PersistedSavedEnvironmentRecordSchema.Type;

export type DesktopServerExposureMode = "local-only" | "network-accessible";

export const DesktopServerExposureModeSchema = Schema.Literals([
  "local-only",
  "network-accessible",
]);

export interface DesktopServerExposureState {
  mode: DesktopServerExposureMode;
  endpointUrl: string | null;
  advertisedHost: string | null;
  tailscaleServeEnabled: boolean;
  tailscaleServePort: number;
}

export const DesktopServerExposureStateSchema = Schema.Struct({
  mode: DesktopServerExposureModeSchema,
  endpointUrl: Schema.NullOr(Schema.String),
  advertisedHost: Schema.NullOr(Schema.String),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: Schema.Number,
});

export interface PickFolderOptions {
  initialPath?: string | null;
  // When set, the desktop dialog opens against the named backend's
  // filesystem instead of the primary's. Used by callers that already
  // know which local environment they're targeting (e.g. opening a
  // project that lives inside WSL). Omitting it keeps the historical
  // behavior so non-WSL users never see a different picker.
  targetEnvironmentId?: string;
}

export const PickFolderOptionsSchema = Schema.Struct({
  initialPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  targetEnvironmentId: Schema.optionalKey(Schema.String),
});

/**
 * A file returned by the desktop theme-file picker. Oversized files carry an
 * empty text so the renderer can reject them by size without the main
 * process ever holding their contents.
 */
export interface PickedThemeFile {
  name: string;
  size: number;
  text: string;
}

export const PickedThemeFileSchema = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  text: Schema.String,
});

export interface DesktopWslDistro {
  name: string;
  isDefault: boolean;
  version: 1 | 2;
}

export const DesktopWslDistroSchema = Schema.Struct({
  name: Schema.String,
  isDefault: Schema.Boolean,
  version: Schema.Literals([1, 2]),
});

export interface DesktopWslState {
  // True when the user has opted the WSL backend in; the actual backend
  // process is registered with the desktop pool independently of this
  // flag and may take a moment to come up after the user enables it.
  enabled: boolean;
  // null means "track the current WSL default distro".
  distro: string | null;
  available: boolean;
  // When true (and `enabled` is also true) the desktop runs only the
  // WSL backend as the primary; the Windows-side Node backend is not
  // started. Toggling this requires an app restart because the
  // primary backend's spec is captured once at layer init.
  wslOnly: boolean;
  distros: readonly DesktopWslDistro[];
  // Reason the dual-mode WSL backend last failed preflight (no node, wrong
  // version, missing build tools), or null. Surfaced inline in Connections
  // settings. Always null in wsl-only mode — that path shows a dialog and
  // falls back to Windows instead.
  preflightError: string | null;
}

export const DesktopWslStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  distro: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  wslOnly: Schema.Boolean,
  distros: Schema.Array(DesktopWslDistroSchema),
  preflightError: Schema.NullOr(Schema.String),
});

/**
 * Renderer-facing snapshot of a desktop preview tab. Mirrors the main-process
 * PreviewTabState shape but uses serialisable primitives only.
 */
export type DesktopPreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | {
      kind: "LoadFailed";
      url: string;
      title: string;
      code: number;
      description: string;
    };

/**
 * Emulated `prefers-color-scheme` for the guest page. "system" clears the
 * override so the page follows the OS appearance.
 */
export type DesktopPreviewColorScheme = "system" | "light" | "dark";

export const DesktopPreviewColorSchemeSchema: Schema.Codec<DesktopPreviewColorScheme> =
  Schema.Literals(["system", "light", "dark"]);

export const FAVICON_DATA_URL_MAX_LENGTH = 8192;
export const FAVICON_CAPTURED_AT_MAX = 8_640_000_000_000_000;

export interface DesktopPreviewFavicon {
  dataUrl: string;
  pageUrl: string;
  capturedAt: number;
}

export interface DesktopPreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: DesktopPreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Current zoom factor (1.0 = 100%). */
  zoomFactor: number;
  /** Whether this tab is currently mirrored into a desktop picture-in-picture window. */
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  /**
   * Whether the user has silenced this tab. Per tab rather than per origin, so
   * two tabs on the same site mute independently. Survives navigation and
   * webview swaps, but is dropped when the tab closes.
   */
  audioMuted: boolean;
  /**
   * Whether the guest is currently emitting audio. Observed from Chromium, and
   * independent of {@link audioMuted}: a muted tab that is playing still reports
   * `true`, which is what lets the tab strip distinguish "muted and making
   * sound" from "muted and silent".
   */
  audible: boolean;
  controller: "human" | "agent" | "none";
  favicon?: DesktopPreviewFavicon;
  updatedAt: string;
}

export const DesktopPreviewTabIdSchema = Schema.String.check(Schema.isTrimmed()).check(
  Schema.isNonEmpty(),
);

export interface DesktopPreviewPointerEvent {
  tabId: string;
  phase: "move" | "click";
  x: number;
  y: number;
  sequence: number;
  createdAt: string;
}

/** A `target="_blank"` link the previewed page asked to open beside itself. */
export interface DesktopPreviewOpenLinkEvent {
  tabId: string;
  url: string;
  /** True for middle-click / Cmd-click, which should not take focus. */
  background: boolean;
}

/** Recording decorations are forwarded separately from the captured page pixels. */
export const DesktopPreviewRecordingInputSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pointer"),
    phase: Schema.Literals(["move", "down", "up", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
    width: Schema.Finite.check(Schema.isGreaterThan(0)),
    height: Schema.Finite.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    label: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
    held: Schema.Boolean,
    width: Schema.Finite.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({ type: Schema.Literal("clear") }),
]);
export type DesktopPreviewRecordingInput = typeof DesktopPreviewRecordingInputSchema.Type;
export interface DesktopPreviewRecordingInputEvent {
  readonly tabId: string;
  readonly input: DesktopPreviewRecordingInput;
}

/**
 * Static config a renderer needs to mount a preview `<webview>`. Returned
 * atomically by `DesktopPreviewBridge.getPreviewConfig()` so the renderer
 * doesn't have to wait on three separate IPC round-trips before the webview
 * can attach.
 */
export interface DesktopPreviewWebviewConfig {
  /** `persist:t3code-preview` (or whatever the desktop chose). */
  partition: string;
  /**
   * Canonical `<webview webpreferences="...">` string. Encodes the security
   * posture (sandboxed but contextIsolation off so the picker preload can
   * read the page's React DevTools hook). Always present.
   */
  webPreferences: string;
  /**
   * Absolute `file://`-style URL to the picker preload bundle. Set to null
   * when the bundle isn't present (older builds, broken install) — the
   * renderer must then disable element-pick affordances.
   */
  preloadUrl: string | null;
}

export const DesktopPreviewWebviewConfigSchema: Schema.Codec<DesktopPreviewWebviewConfig> =
  Schema.Struct({
    partition: Schema.String,
    webPreferences: Schema.String,
    preloadUrl: Schema.NullOr(Schema.String),
  });

export interface DesktopPreviewAnnotationTheme {
  colorScheme: "light" | "dark";
  radius: string;
  background: string;
  foreground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  input: string;
  ring: string;
  fontSans: string;
  fontMono: string;
}

export const DesktopPreviewAnnotationThemeSchema: Schema.Codec<DesktopPreviewAnnotationTheme> =
  Schema.Struct({
    colorScheme: Schema.Literals(["light", "dark"]),
    radius: Schema.String,
    background: Schema.String,
    foreground: Schema.String,
    popover: Schema.String,
    popoverForeground: Schema.String,
    primary: Schema.String,
    primaryForeground: Schema.String,
    muted: Schema.String,
    mutedForeground: Schema.String,
    accent: Schema.String,
    accentForeground: Schema.String,
    border: Schema.String,
    input: Schema.String,
    ring: Schema.String,
    fontSans: Schema.String,
    fontMono: Schema.String,
  });

export interface DesktopPreviewRecordingFrame {
  tabId: string;
  data: string;
  width: number;
  height: number;
  receivedAt: string;
}

export interface DesktopPreviewRecordingArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export const DesktopPreviewRecordingArtifactSchema: Schema.Codec<DesktopPreviewRecordingArtifact> =
  Schema.Struct({
    id: Schema.String,
    tabId: DesktopPreviewTabIdSchema,
    path: Schema.String,
    mimeType: Schema.String,
    sizeBytes: Schema.Int,
    createdAt: Schema.String,
  });

export interface DesktopPreviewScreenshotArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: "image/png";
  sizeBytes: number;
  createdAt: string;
}

export const DesktopPreviewScreenshotArtifactSchema: Schema.Codec<DesktopPreviewScreenshotArtifact> =
  Schema.Struct({
    id: Schema.String,
    tabId: DesktopPreviewTabIdSchema,
    path: Schema.String,
    mimeType: Schema.Literal("image/png"),
    sizeBytes: Schema.Int,
    createdAt: Schema.String,
  });

/**
 * Single stack frame captured by react-grab's `getElementContext`. We surface
 * the source file/line so coding agents can jump straight to the JSX that
 * produced the picked DOM node.
 */
export interface PickedElementStackFrame {
  functionName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
}

export const PickedElementStackFrameSchema: Schema.Codec<PickedElementStackFrame> = Schema.Struct({
  functionName: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  lineNumber: Schema.NullOr(Schema.Number),
  columnNumber: Schema.NullOr(Schema.Number),
});

/**
 * A successful element pick from the preview webview. All fields are
 * best-effort — pages that don't ship a React fiber tree (or aren't running
 * in dev) will still produce a usable payload (selector + html preview),
 * just without component / source attribution.
 */
export interface PickedElementPayload {
  /** URL of the page the element was picked on. */
  pageUrl: string;
  /** Optional `<title>` of that page (best-effort). */
  pageTitle: string | null;
  /** Lowercase tag name, e.g. `"button"`. */
  tagName: string;
  /** CSS selector resolving back to the element on a re-render. */
  selector: string | null;
  /** Truncated outer-HTML preview (matches react-grab's `htmlPreview`). */
  htmlPreview: string;
  /** Nearest React component display name, or null when unavailable. */
  componentName: string | null;
  /** First source-mapped stack frame (file + line of the JSX source). */
  source: PickedElementStackFrame | null;
  /** Full owner-stack frames; can be empty. Useful for richer context. */
  stack: ReadonlyArray<PickedElementStackFrame>;
  /** Author CSS only (UA defaults stripped) — react-grab's `styles`. */
  styles: string;
  /** Wall-clock pick time as ISO-8601 string. */
  pickedAt: string;
}

export const PickedElementPayloadSchema: Schema.Codec<PickedElementPayload> = Schema.Struct({
  pageUrl: Schema.String,
  pageTitle: Schema.NullOr(Schema.String),
  tagName: Schema.String,
  selector: Schema.NullOr(Schema.String),
  htmlPreview: Schema.String,
  componentName: Schema.NullOr(Schema.String),
  source: Schema.NullOr(PickedElementStackFrameSchema),
  stack: Schema.Array(PickedElementStackFrameSchema),
  styles: Schema.String,
  pickedAt: Schema.String,
});

export interface PreviewAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PreviewAnnotationRectSchema: Schema.Codec<PreviewAnnotationRect> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});

export interface PreviewAnnotationPoint {
  x: number;
  y: number;
}

export const PreviewAnnotationPointSchema: Schema.Codec<PreviewAnnotationPoint> = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

export interface PreviewAnnotationElementTarget {
  id: string;
  element: PickedElementPayload;
  rect: PreviewAnnotationRect;
}

export const PreviewAnnotationElementTargetSchema: Schema.Codec<PreviewAnnotationElementTarget> =
  Schema.Struct({
    id: Schema.String,
    element: PickedElementPayloadSchema,
    rect: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationRegionTarget {
  id: string;
  rect: PreviewAnnotationRect;
}

export const PreviewAnnotationRegionTargetSchema: Schema.Codec<PreviewAnnotationRegionTarget> =
  Schema.Struct({
    id: Schema.String,
    rect: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationStrokeTarget {
  id: string;
  color: string;
  width: number;
  points: ReadonlyArray<PreviewAnnotationPoint>;
  bounds: PreviewAnnotationRect;
}

export const PreviewAnnotationStrokeTargetSchema: Schema.Codec<PreviewAnnotationStrokeTarget> =
  Schema.Struct({
    id: Schema.String,
    color: Schema.String,
    width: Schema.Number,
    points: Schema.Array(PreviewAnnotationPointSchema),
    bounds: PreviewAnnotationRectSchema,
  });

export interface PreviewAnnotationStyleChange {
  targetId: string;
  selector: string | null;
  property: string;
  previousValue: string;
  value: string;
}

export const PreviewAnnotationStyleChangeSchema: Schema.Codec<PreviewAnnotationStyleChange> =
  Schema.Struct({
    targetId: Schema.String,
    selector: Schema.NullOr(Schema.String),
    property: Schema.String,
    previousValue: Schema.String,
    value: Schema.String,
  });

export interface PreviewAnnotationScreenshot {
  dataUrl: string;
  width: number;
  height: number;
  cropRect: PreviewAnnotationRect;
}

export const PreviewAnnotationScreenshotSchema: Schema.Codec<PreviewAnnotationScreenshot> =
  Schema.Struct({
    dataUrl: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    cropRect: PreviewAnnotationRectSchema,
  });

/**
 * A submitted preview annotation. One annotation may reference multiple DOM
 * elements, freeform regions, and ink strokes. The desktop main process adds
 * the screenshot after the guest preload submits the structured draft.
 */
export interface PreviewAnnotationPayload {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  comment: string;
  elements: ReadonlyArray<PreviewAnnotationElementTarget>;
  regions: ReadonlyArray<PreviewAnnotationRegionTarget>;
  strokes: ReadonlyArray<PreviewAnnotationStrokeTarget>;
  styleChanges: ReadonlyArray<PreviewAnnotationStyleChange>;
  screenshot: PreviewAnnotationScreenshot | null;
  createdAt: string;
}

export const PreviewAnnotationPayloadSchema: Schema.Codec<PreviewAnnotationPayload> = Schema.Struct(
  {
    id: Schema.String,
    pageUrl: Schema.String,
    pageTitle: Schema.NullOr(Schema.String),
    comment: Schema.String,
    elements: Schema.Array(PreviewAnnotationElementTargetSchema),
    regions: Schema.Array(PreviewAnnotationRegionTargetSchema),
    strokes: Schema.Array(PreviewAnnotationStrokeTargetSchema),
    styleChanges: Schema.Array(PreviewAnnotationStyleChangeSchema),
    screenshot: Schema.NullOr(PreviewAnnotationScreenshotSchema),
    createdAt: Schema.String,
  },
);

export type PreviewAnnotationSubmission = "attach" | "send";
export const PreviewAnnotationSubmissionSchema: Schema.Codec<PreviewAnnotationSubmission> =
  Schema.Literals(["attach", "send"]);

export interface PreviewAnnotationSubmissionResult {
  annotation: PreviewAnnotationPayload;
  submission: PreviewAnnotationSubmission;
  /** The crop was requested but failed or timed out, so `annotation.screenshot` is null. */
  screenshotFailed?: boolean;
}
export const PreviewAnnotationSubmissionResultSchema: Schema.Codec<PreviewAnnotationSubmissionResult> =
  Schema.Struct({
    annotation: PreviewAnnotationPayloadSchema,
    submission: PreviewAnnotationSubmissionSchema,
    screenshotFailed: Schema.optionalKey(Schema.Boolean),
  });

export const DesktopPreviewTabInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
});

/**
 * Tab creation carries the client's configured browser defaults so the guest
 * is born already zoomed and color-scheme-emulated. Applying them after
 * creation instead would paint one frame at 100%/system first, which reads as
 * a flash on every tab open. Both fields are optional so an older renderer
 * still gets the historical defaults.
 */
export const DesktopPreviewCreateTabInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  zoomFactor: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  colorScheme: Schema.optional(DesktopPreviewColorSchemeSchema),
  serverTab: Schema.optional(
    Schema.Struct({ threadId: TrimmedNonEmptyString, tabId: TrimmedNonEmptyString }),
  ),
});

export interface DesktopPreviewTabDefaults {
  readonly zoomFactor?: number | undefined;
  readonly colorScheme?: DesktopPreviewColorScheme | undefined;
  /** A tab of the desktop's own server: the server drives it through the desktop browser channel. */
  readonly serverTab?: { readonly threadId: string; readonly tabId: string } | undefined;
}

export const DesktopPreviewRegisterWebviewInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  webContentsId: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const DesktopPreviewNavigateInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  url: Schema.String,
});

export const DesktopPreviewConfigInputSchema = Schema.Struct({
  environmentId: EnvironmentId,
  /**
   * Browser profile the partition is derived from. Derivation stays in main:
   * `will-attach-webview` only prefix-checks the partition string, so a
   * renderer-supplied partition could attach to a session that never had the
   * UA rewrite or permission handlers installed.
   */
  profileId: Schema.optional(BrowserProfileId),
});

export const DesktopPreviewClearDataInputSchema = Schema.Struct({
  environmentId: EnvironmentId,
  /** Omit to clear every profile; otherwise only this profile's partition. */
  profileId: Schema.optional(BrowserProfileId),
});

export const DesktopPreviewSetColorSchemeInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  colorScheme: DesktopPreviewColorSchemeSchema,
});

export const DesktopPreviewSetZoomFactorInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  zoomFactor: Schema.Number.check(Schema.isGreaterThan(0)),
});

export const DesktopPreviewSetAudioMutedInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  audioMuted: Schema.Boolean,
});

export const DesktopPreviewAnnotationThemeInputSchema = Schema.Struct({
  theme: DesktopPreviewAnnotationThemeSchema,
});

export const DesktopPreviewAnnotationSendEnabledInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  enabled: Schema.Boolean,
});

export const DesktopPreviewArtifactInputSchema = Schema.Struct({
  path: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
});

export const DesktopPreviewRecordingSaveInputSchema = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  mimeType: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  data: Schema.Uint8Array,
});

/**
 * A System Settings pane the app can deep-link to. The identifier crosses IPC
 * rather than a URL, so the renderer can only reach these known destinations.
 */
export const SystemSettingsPaneSchema = Schema.Literals(["full-disk-access"]);
export type SystemSettingsPane = typeof SystemSettingsPaneSchema.Type;

/** Normalized snapshot from the optional local OpenRig bridge. */
export const DesktopOpenRigAgentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  role: Schema.NullOr(Schema.String),
  task: Schema.NullOr(Schema.String),
  /** Explicitly bound: a native thread or conversation need not have a browser tab ID. */
  bound: Schema.Boolean,
  bindingKind: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  sessionTitle: Schema.NullOr(Schema.String),
});
export type DesktopOpenRigAgent = typeof DesktopOpenRigAgentSchema.Type;

/** OpenRig's durable conversation references; browser IDs are only legacy attachments. */
export const DesktopOpenRigSessionTargetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("t3-thread"),
    environmentId: Schema.String,
    threadId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("chatgpt-conversation"),
    conversationId: Schema.String,
    preferredBrowserSessionId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("legacy-browser"),
    sessionId: Schema.String,
  }),
]);
export type DesktopOpenRigSessionTarget = typeof DesktopOpenRigSessionTargetSchema.Type;

export const DesktopOpenRigSessionSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  project: Schema.NullOr(Schema.String),
  status: Schema.String,
  kind: Schema.String,
  target: DesktopOpenRigSessionTargetSchema,
  provider: Schema.NullOr(Schema.String),
});
export type DesktopOpenRigSession = typeof DesktopOpenRigSessionSchema.Type;

/** OpenRig owns the many-to-one seat/session ledger. T3 displays it but never infers ownership. */
export const DesktopOpenRigManagedSessionSchema = Schema.Struct({
  id: Schema.String,
  seatId: Schema.String,
  operationId: Schema.String,
  mode: Schema.Union([
    Schema.Literal("native"),
    Schema.Literal("chatgpt"),
    Schema.Literal("adopt"),
  ]),
  status: Schema.Union([
    Schema.Literal("pending"),
    Schema.Literal("active"),
    Schema.Literal("unavailable"),
    Schema.Literal("indeterminate"),
    Schema.Literal("stopped"),
    Schema.Literal("detached"),
  ]),
  primary: Schema.Boolean,
  target: Schema.NullOr(DesktopOpenRigSessionTargetSchema),
  targetKey: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  attachedTabUuid: Schema.NullOr(Schema.String),
  parentSeatId: Schema.NullOr(Schema.String),
  parentManagedSessionId: Schema.NullOr(Schema.String),
  provenance: Schema.Unknown,
  intent: Schema.Unknown,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  error: Schema.NullOr(Schema.String),
  observed: Schema.Unknown,
  modelCompletionVerified: Schema.Boolean,
  title: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.NullOr(Schema.String)),
  lastActivityAt: Schema.optional(Schema.NullOr(Schema.String)),
  /** Read-only native recovery evidence. Never proves the bootstrap ran or authorizes a retry. */
  recoveryEvidence: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        threadFound: Schema.Boolean,
        exactEnvironmentAndProvider: Schema.Boolean,
        initialMessageAcknowledged: Schema.Boolean,
        safeToRetryLaunch: Schema.Literal(false),
        reconciliationRequired: Schema.Boolean,
      }),
    ),
  ),
});
export type DesktopOpenRigManagedSession = typeof DesktopOpenRigManagedSessionSchema.Type;

export const DesktopOpenRigSeatSessionsSchema = Schema.Struct({
  version: Schema.Literal(1),
  seatId: Schema.String,
  primarySessionId: Schema.NullOr(Schema.String),
  sessions: Schema.Array(DesktopOpenRigManagedSessionSchema),
  legacyBinding: Schema.Unknown,
  legacyAutoImported: Schema.Literal(false),
  pendingRecoveryCount: Schema.Number,
  launchPolicy: Schema.Struct({
    explicitOperationIdRequired: Schema.Literal(true),
    duplicateOperationRetrySafe: Schema.Literal(false),
    automaticUnknownRetry: Schema.Literal(false),
    implicitAdoption: Schema.Literal(false),
  }),
});
export type DesktopOpenRigSeatSessions = typeof DesktopOpenRigSeatSessionsSchema.Type;

/** Operator-approved, exact T3 provider catalog profile. Never derived from the current editor tab. */
export const DesktopOpenRigRuntimeModeSchema = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export const DesktopOpenRigExecutionProfileRecordSchema = Schema.Struct({
  seatId: Schema.String,
  environmentId: Schema.String,
  workspaceRoot: Schema.String,
  runtime: Schema.Literals(["codex", "claude"]),
  providerInstanceId: Schema.String,
  model: Schema.String,
  runtimeMode: DesktopOpenRigRuntimeModeSchema,
  provenance: Schema.Literal("operator-explicit-t3-provider-catalog"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type DesktopOpenRigExecutionProfileRecord =
  typeof DesktopOpenRigExecutionProfileRecordSchema.Type;
const DesktopOpenRigRigSpecExecutionSchema = Schema.Struct({
  runtime: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  runtimeMode: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
});
export const DesktopOpenRigExecutionProfileSchema = Schema.Struct({
  version: Schema.Literal(1),
  seatId: Schema.String,
  profile: Schema.NullOr(DesktopOpenRigExecutionProfileRecordSchema),
  rigSpec: DesktopOpenRigRigSpecExecutionSchema,
  effective: Schema.Union([
    DesktopOpenRigExecutionProfileRecordSchema,
    DesktopOpenRigRigSpecExecutionSchema,
  ]),
  nativeLaunchReady: Schema.Boolean,
  missing: Schema.Array(Schema.String),
  legacySessionsAutoAdopted: Schema.Literal(false),
  requiresOperatorApproval: Schema.Boolean,
  providerSelectionAuthority: Schema.Literal("T3 exact live provider catalog"),
  overwriteRigSpec: Schema.Literal(false),
});
export type DesktopOpenRigExecutionProfile = typeof DesktopOpenRigExecutionProfileSchema.Type;
export const DesktopOpenRigConfigureExecutionProfileInputSchema = Schema.Struct({
  seatId: Schema.String,
  workspaceRoot: Schema.String,
  providerInstanceId: Schema.String,
  model: Schema.String,
  runtimeMode: DesktopOpenRigRuntimeModeSchema,
  environmentId: Schema.optional(Schema.String),
});
export type DesktopOpenRigConfigureExecutionProfileInput =
  typeof DesktopOpenRigConfigureExecutionProfileInputSchema.Type;

/** Idempotency/correlation identity is supplied once by the operator, never regenerated on retry. */
export const DesktopOpenRigLaunchInputSchema = Schema.Struct({
  seatId: Schema.String,
  operationId: Schema.String,
  kind: Schema.optional(Schema.Union([Schema.Literal("native"), Schema.Literal("chatgpt")])),
  initialPrompt: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  workspaceRoot: Schema.optional(Schema.String),
  parentSeatId: Schema.optional(Schema.String),
  parentManagedSessionId: Schema.optional(Schema.String),
});
export type DesktopOpenRigLaunchInput = typeof DesktopOpenRigLaunchInputSchema.Type;

export const DesktopOpenRigAdoptInputSchema = Schema.Struct({
  seatId: Schema.String,
  operationId: Schema.String,
  target: DesktopOpenRigSessionTargetSchema,
});
export type DesktopOpenRigAdoptInput = typeof DesktopOpenRigAdoptInputSchema.Type;

export const DesktopOpenRigSessionActionInputSchema = Schema.Struct({
  seatId: Schema.String,
  sessionId: Schema.String,
});
export type DesktopOpenRigSessionActionInput = typeof DesktopOpenRigSessionActionInputSchema.Type;

/** Only the exact current primary managed ChatGPT browser can receive lifecycle actions. */
export const DesktopOpenRigManagedBrowserLifecycleInputSchema = Schema.Union([
  Schema.Struct({
    seatId: Schema.String,
    sessionId: Schema.String,
    action: Schema.Literals(["suspend", "resume", "recover"]),
  }),
  Schema.Struct({
    seatId: Schema.String,
    sessionId: Schema.String,
    action: Schema.Literal("stop"),
    confirm: Schema.Literal("close-local-t3-session"),
  }),
]);
export type DesktopOpenRigManagedBrowserLifecycleInput =
  typeof DesktopOpenRigManagedBrowserLifecycleInputSchema.Type;

/** OpenRig's positive receipt is distinct from model completion or cloud deletion. */
export const DesktopOpenRigManagedBrowserLifecycleResultSchema = Schema.Struct({
  version: Schema.Literal(1),
  seatId: Schema.String,
  managedSessionId: Schema.String,
  primarySessionId: Schema.NullOr(Schema.String),
  browserSessionId: Schema.String,
  conversationId: Schema.String,
  action: Schema.Literals(["suspend", "resume", "stop", "recover"]),
  effect: Schema.Literals([
    "t3_archived_local_browser_unmounted_no_model_completion_claim",
    "t3_archive_restored_reattachment_on_render",
    "safe_saved_conversation_navigation_requested_not_verified_loaded",
    "local_t3_session_closed_not_chatgpt_cloud_deleted",
  ]),
  providerAcknowledged: Schema.Literal(true),
  modelCompletionVerified: Schema.Literal(false),
  managedStatus: Schema.Literals(["active", "detached"]),
  managedPrimaryUnchanged: Schema.Boolean,
  source: Schema.Literal("t3-existing-desktop-session-control"),
  receipt: Schema.Unknown,
});
export type DesktopOpenRigManagedBrowserLifecycleResult =
  typeof DesktopOpenRigManagedBrowserLifecycleResultSchema.Type;

export const DesktopOpenRigPrimaryInputSchema = Schema.Struct({
  seatId: Schema.String,
  sessionId: Schema.String,
});
export type DesktopOpenRigPrimaryInput = typeof DesktopOpenRigPrimaryInputSchema.Type;

export const DesktopOpenRigBindInputSchema = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.optional(Schema.String),
  target: Schema.optional(DesktopOpenRigSessionTargetSchema),
});
export type DesktopOpenRigBindInput = typeof DesktopOpenRigBindInputSchema.Type;

export const DesktopOpenRigSendInputSchema = Schema.Struct({
  id: Schema.String,
  message: Schema.String,
});
export type DesktopOpenRigSendInput = typeof DesktopOpenRigSendInputSchema.Type;
/** Exact-route reconciliation never treats an absent message as permission to resend. */
export const DesktopOpenRigHumanSendReconcileInputSchema = Schema.Struct({
  id: Schema.String,
  managedSessionId: Schema.String,
  attemptId: Schema.String,
  target: DesktopOpenRigSessionTargetSchema,
});
export type DesktopOpenRigHumanSendReconcileInput =
  typeof DesktopOpenRigHumanSendReconcileInputSchema.Type;
export const DesktopOpenRigHumanSendReconcileResultSchema = Schema.Struct({
  state: Schema.Literals(["observed", "pending", "route_changed"]),
  persisted: Schema.optional(Schema.Boolean),
  assistantAcknowledged: Schema.optional(Schema.Boolean),
});

/** Read-only RigSpec seat hierarchy (delegates_to / spawned_by edges). Never inferred from sessions. */
export const DesktopOpenRigSeatNodeSchema = Schema.Struct({
  id: Schema.String,
  rigId: Schema.String,
  rigName: Schema.String,
  name: Schema.String,
  logicalId: Schema.String,
  role: Schema.NullOr(Schema.String),
  parentIds: Schema.Array(Schema.String),
  childIds: Schema.Array(Schema.String),
});
export type DesktopOpenRigSeatNode = typeof DesktopOpenRigSeatNodeSchema.Type;
/** Preserve whether discovery came from bare RigSpec or the full managed-ledger join. */
export const DesktopOpenRigSeatTopologySchema = Schema.Struct({
  source: Schema.Literals(["openrig-rigspec", "openrig-rigspec-and-managed-ledger"]),
  seats: Schema.Array(DesktopOpenRigSeatNodeSchema),
});
export type DesktopOpenRigSeatTopology = typeof DesktopOpenRigSeatTopologySchema.Type;

/** Persisted seat status reports. The author is never transport-verified. */
export const DesktopOpenRigSeatReportSchema = Schema.Struct({
  reportId: Schema.String,
  status: Schema.Literals(["working", "blocked", "completed", "failed"]),
  summary: Schema.String,
  progress: Schema.NullOr(Schema.Number),
  blockedOn: Schema.Array(Schema.String),
  timestamp: Schema.String,
  eventSeq: Schema.Number,
  authorVerified: Schema.Literal(false),
});
export type DesktopOpenRigSeatReport = typeof DesktopOpenRigSeatReportSchema.Type;
export const DesktopOpenRigSeatReportsSchema = Schema.Struct({
  seatId: Schema.String,
  reports: Schema.Array(DesktopOpenRigSeatReportSchema),
});
export type DesktopOpenRigSeatReports = typeof DesktopOpenRigSeatReportsSchema.Type;

/** Canonical queue read projection; never inferred from browser/session health or delivery receipts. */
export const DesktopOpenRigAgentTaskSchema = Schema.Struct({
  qitemId: Schema.String,
  summary: Schema.NullOr(Schema.String),
  state: Schema.String,
  sourceSession: Schema.String,
  destinationSession: Schema.String,
  handedOffFrom: Schema.NullOr(Schema.String),
  handedOffTo: Schema.NullOr(Schema.String),
  chainOfRecord: Schema.NullOr(Schema.Array(Schema.String)),
  evidenceRef: Schema.NullOr(Schema.String),
  closureReason: Schema.NullOr(Schema.String),
  closureTarget: Schema.NullOr(Schema.String),
  resolution: Schema.NullOr(Schema.String),
  claimedAt: Schema.NullOr(Schema.String),
  tsCreated: Schema.String,
  tsUpdated: Schema.String,
  lastNudgeAttempt: Schema.NullOr(Schema.String),
  lastNudgeResult: Schema.NullOr(Schema.String),
  lastTransition: Schema.NullOr(
    Schema.Struct({
      transitionId: Schema.Number,
      ts: Schema.String,
      state: Schema.String,
      actorSession: Schema.String,
      transitionNote: Schema.NullOr(Schema.String),
      closureReason: Schema.NullOr(Schema.String),
      closureTarget: Schema.NullOr(Schema.String),
    }),
  ),
});
export type DesktopOpenRigAgentTask = typeof DesktopOpenRigAgentTaskSchema.Type;
export const DesktopOpenRigAgentTasksSchema = Schema.Union([
  Schema.Struct({
    schema: Schema.Literal("openrig-t3-agent-tasks/v1"),
    available: Schema.Literal(true),
    agent: Schema.Struct({
      agentId: Schema.String,
      rigId: Schema.String,
      rigName: Schema.String,
      canonicalSession: Schema.String,
    }),
    limit: Schema.Number,
    tasks: Schema.Array(DesktopOpenRigAgentTaskSchema),
    hasMore: Schema.Boolean,
  }),
  Schema.Struct({
    schema: Schema.Literal("openrig-t3-agent-tasks/v1"),
    available: Schema.Literal(false),
    error: Schema.Literals([
      "limit_must_be_1_to_100",
      "agent_not_found",
      "ambiguous_canonical_seat",
      "canonical_task_read_model_unavailable",
    ]),
  }),
]);
export type DesktopOpenRigAgentTasks = typeof DesktopOpenRigAgentTasksSchema.Type;

/** C05 optional, read-only coordination attached to ONE already-authorized browser send. */
export const DesktopOpenRigPolicyIntakeInputSchema = Schema.Struct({
  browserSessionId: Schema.String,
  conversationId: Schema.String,
});
export type DesktopOpenRigPolicyIntakeInput = typeof DesktopOpenRigPolicyIntakeInputSchema.Type;

export const DesktopOpenRigPolicyItemSchema = Schema.Struct({
  qitemId: Schema.String,
  summary: Schema.NullOr(Schema.String),
  body: Schema.String,
  sourceSession: Schema.String,
  destinationSession: Schema.String,
  state: Schema.Literal("pending"),
  priority: Schema.Literal("routine"),
  tags: Schema.Array(Schema.String),
  expiresAt: Schema.NullOr(Schema.String),
  claimedAt: Schema.Null,
  tsCreated: Schema.String,
  tsUpdated: Schema.String,
  lastTransition: Schema.NullOr(
    Schema.Struct({
      transitionId: Schema.Number,
      ts: Schema.String,
      state: Schema.String,
      actorSession: Schema.String,
      transitionNote: Schema.NullOr(Schema.String),
      closureReason: Schema.NullOr(Schema.String),
      closureTarget: Schema.NullOr(Schema.String),
    }),
  ),
});
export type DesktopOpenRigPolicyItem = typeof DesktopOpenRigPolicyItemSchema.Type;

export const DesktopOpenRigPolicyPageSchema = Schema.Struct({
  schema: Schema.Literal("openrig-t3-policy-intake/v1"),
  available: Schema.Literal(true),
  view: Schema.Literal("policy"),
  agent: Schema.Struct({
    agentId: Schema.String,
    rigId: Schema.String,
    rigName: Schema.String,
    canonicalSession: Schema.String,
  }),
  selector: Schema.Struct({
    state: Schema.Literal("pending"),
    priority: Schema.Literal("routine"),
    tag: Schema.Literal("coordination:policy"),
    unclaimed: Schema.Literal(true),
  }),
  expirySemantics: Schema.Literal("metadata_only_not_enforced"),
  deliverySemantics: Schema.Literal("read_only_not_offered_to_model_or_acknowledged"),
  limit: Schema.Literal(25),
  policies: Schema.Array(DesktopOpenRigPolicyItemSchema),
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
});
export type DesktopOpenRigPolicyPage = typeof DesktopOpenRigPolicyPageSchema.Type;

export const DesktopOpenRigPolicyIntakeResultSchema = Schema.Union([
  Schema.Struct({
    schema: Schema.Literal("t3-c05-browser-optional/v1"),
    status: Schema.Literal("ready"),
    agentId: Schema.String,
    managedSessionId: Schema.String,
    browserSessionId: Schema.String,
    conversationId: Schema.String,
    canonicalSession: Schema.String,
    policies: Schema.Array(DesktopOpenRigPolicyItemSchema),
  }),
  Schema.Struct({
    schema: Schema.Literal("t3-c05-browser-optional/v1"),
    status: Schema.Literal("deferred"),
    reason: Schema.String,
  }),
]);
export type DesktopOpenRigPolicyIntakeResult = typeof DesktopOpenRigPolicyIntakeResultSchema.Type;

/** Canonical, read-only OpenRig native-spawn approval projection.
 * Rendering it NEVER gives the renderer approval authority. */
export const DesktopOpenRigNativeApprovalSchema = Schema.Struct({
  id: Schema.String,
  operationId: Schema.String,
  descriptorSha256: Schema.String,
  stateVersion: Schema.Number,
  status: Schema.Literals([
    "requested",
    "pending_approval",
    "approved",
    "denied",
    "expired",
    "reserved_for_execution",
    "launched",
    "indeterminate",
  ]),
  requestedAt: Schema.String,
  expiresAt: Schema.String,
  target: Schema.Struct({
    environmentId: Schema.String,
    providerInstanceId: Schema.String,
    driver: Schema.String,
    modelSlug: Schema.String,
    modelOptions: Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          value: Schema.Union([Schema.String, Schema.Boolean]),
        }),
      ),
    ),
    reasoningEffort: Schema.NullOr(Schema.String),
    runtimeMode: Schema.String,
    projectId: Schema.NullOr(Schema.String),
    workspaceRoot: Schema.String,
    resolvedExecutionPath: Schema.NullOr(Schema.String),
  }),
  requester: Schema.Struct({
    verified: Schema.Boolean,
    callerSeatId: Schema.NullOr(Schema.String),
    sourceThreadId: Schema.NullOr(Schema.String),
    parentThreadId: Schema.NullOr(Schema.String),
  }),
  task: Schema.Struct({
    title: Schema.String,
    preview: Schema.String,
    promptSha256: Schema.String,
  }),
  decisionWriteAvailable: Schema.Literal(false),
  estimatedCostUsd: Schema.Null,
});
export type DesktopOpenRigNativeApproval = typeof DesktopOpenRigNativeApprovalSchema.Type;

export const DesktopOpenRigNativeApprovalPageSchema = Schema.Struct({
  source: Schema.Literal("openrig-canonical-sqlite"),
  address: Schema.Literal("human@kernel"),
  items: Schema.Array(DesktopOpenRigNativeApprovalSchema),
  count: Schema.Number,
  truncated: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.Struct({ requestedAt: Schema.String, id: Schema.String })),
  decisionWriteAvailable: Schema.Literal(false),
  executionReserveAvailable: Schema.Literal(false),
  note: Schema.String,
});
export type DesktopOpenRigNativeApprovalPage = typeof DesktopOpenRigNativeApprovalPageSchema.Type;

/** Native review is MAIN-controlled. Renderer supplies only the operation lookup ID;
 * this outcome comes from the canonical authority, never a renderer choice. */
export const DesktopOpenRigNativeReviewResultSchema = Schema.Struct({
  outcome: Schema.Literals(["recorded", "cancelled", "verification-unavailable"]),
  item: Schema.NullOr(DesktopOpenRigNativeApprovalSchema),
});
export type DesktopOpenRigNativeReviewResult = typeof DesktopOpenRigNativeReviewResultSchema.Type;

/** Read-only human-directed messages from OpenRig's queue and mailbox, not a read-receipt store. */
export const DesktopOpenRigInboxItemSchema = Schema.Struct({
  id: Schema.String,
  sender: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  state: Schema.String,
  requiresAction: Schema.Boolean,
  sourceType: Schema.Literals(["queue", "mailbox", "human_gate", "spawn_approval"]),
  attentionKind: Schema.optional(Schema.Literals(["notice", "message", "decision"])),
  replyEligible: Schema.optional(Schema.Boolean),
  replyUnavailableReason: Schema.optional(Schema.String),
  spawnApproval: Schema.optional(Schema.Unknown),
  /** Optional validated agent-authored form/media envelope; legacy senders use an openrig-form fence in body. */
  rich: Schema.optional(Schema.Unknown),
  humanForm: Schema.optional(Schema.Unknown),
  humanAnswers: Schema.optional(Schema.Unknown),
  humanQuestions: Schema.optional(Schema.Unknown),
  recipient: Schema.optional(Schema.String),
  humanIntent: Schema.optional(Schema.NullOr(Schema.Literals(["decision", "update"]))),
  /** An update is surfaced only when explicitly requested or an exceptional milestone. */
  notificationReason: Schema.optional(Schema.Literals(["requested", "milestone"])),
  relatedTo: Schema.optional(Schema.String),
  /** Linked TaskBoard review gate; only `decodeOpenRigReviewGate` output may be trusted. */
  reviewGate: Schema.optional(Schema.Unknown),
});
export type DesktopOpenRigInboxItem = typeof DesktopOpenRigInboxItemSchema.Type;

export const OPENRIG_REVIEW_GATE_VERDICTS = ["approved", "changes_requested", "rejected"] as const;
export type OpenRigReviewGateVerdict = (typeof OPENRIG_REVIEW_GATE_VERDICTS)[number];
export interface OpenRigReviewGate {
  readonly gateQitemId: string;
  readonly reviewId: string;
  readonly reviewRevision: string;
  /** A display-only link from OpenRig; the containing human_gate item carries live gate state. */
  readonly authorityVerified: false;
  readonly title: string | null;
  readonly reviewUrl: string | null;
  readonly thumbnailUrl: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** TaskBoard is a local web tool: only credential-free loopback http(s) URLs. */
export function safeOpenRigReviewUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !LOOPBACK_HOSTS.has(url.hostname) ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeReviewThumbnail(value: unknown): string | null {
  if (
    typeof value === "string" &&
    value.length <= 200_000 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(value)
  )
    return value;
  return safeOpenRigReviewUrl(value);
}

/** Strict decode of an inbox item's review-gate link. Anything malformed is not a gate. */
export function decodeOpenRigReviewGate(value: unknown): OpenRigReviewGate | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const gate = value as Record<string, unknown>;
  if (
    typeof gate.gateQitemId !== "string" ||
    !/^qitem-[A-Za-z0-9_-]{1,100}$/u.test(gate.gateQitemId) ||
    typeof gate.reviewId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(gate.reviewId) ||
    typeof gate.reviewRevision !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(gate.reviewRevision) ||
    gate.authorityVerified !== false
  )
    return null;
  return {
    gateQitemId: gate.gateQitemId,
    reviewId: gate.reviewId,
    reviewRevision: gate.reviewRevision,
    authorityVerified: false,
    title: typeof gate.title === "string" ? gate.title.slice(0, 200) : null,
    reviewUrl: safeOpenRigReviewUrl(gate.reviewUrl),
    thumbnailUrl: safeReviewThumbnail(gate.thumbnailUrl),
  };
}
export const DesktopOpenRigInboxSchema = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  address: Schema.String,
  addresses: Schema.Array(Schema.Struct({ address: Schema.String, label: Schema.String })),
  items: Schema.Array(DesktopOpenRigInboxItemSchema),
  pendingCount: Schema.NullOr(Schema.Number),
  count: Schema.Number,
  truncated: Schema.Boolean,
  /** Capabilities are optional for older daemons; absence must not enable writes. */
  answerWriteAvailable: Schema.optional(Schema.Boolean),
  replyWriteAvailable: Schema.optional(Schema.Boolean),
});
export type DesktopOpenRigInbox = typeof DesktopOpenRigInboxSchema.Type;

/** A response is accepted only after the durable OpenRig reply endpoint confirms it. */
export const DesktopOpenRigHumanResponseInputSchema = Schema.Struct({
  version: Schema.Literal(2),
  destination: Schema.String,
  qitemId: Schema.String,
  answers: Schema.Array(
    Schema.Struct({
      questionId: Schema.String,
      value: Schema.Union([Schema.String, Schema.Number, Schema.Array(Schema.String)]),
    }),
  ),
});
export type DesktopOpenRigHumanResponseInput = typeof DesktopOpenRigHumanResponseInputSchema.Type;
export const DesktopOpenRigHumanResponseResultSchema = Schema.Struct({
  version: Schema.Literal(2),
  qitemId: Schema.String,
  actor: Schema.Literal("human@kernel"),
  acceptedIntoQueue: Schema.Boolean,
  status: Schema.Literals(["recorded", "idempotent"]),
  complete: Schema.Boolean,
  answeredCount: Schema.Number,
  remainingQuestionIds: Schema.Array(Schema.String),
  replyQitemId: Schema.NullOr(Schema.String),
  delivery: Schema.Literals(["queued", "verified", "indeterminate", "failed", "not-applicable"]),
  deliveredToAgent: Schema.Boolean,
});
export type DesktopOpenRigHumanResponseResult = typeof DesktopOpenRigHumanResponseResultSchema.Type;

/** MAIN only contacts the canonical original qitem; no renderer-supplied sender identity. */
export const DesktopOpenRigOperatorReplyInputSchema = Schema.Struct({
  sourceType: Schema.Literal("queue"),
  qitemId: Schema.String,
  destination: Schema.Literal("human@kernel"),
  expectedRecipient: Schema.String,
  requestId: Schema.String,
  message: Schema.String,
});
export type DesktopOpenRigOperatorReplyInput = typeof DesktopOpenRigOperatorReplyInputSchema.Type;
export const DesktopOpenRigOperatorReplyResultSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("accepted"),
    requestId: Schema.String,
    qitemId: Schema.String,
    replyQitemId: Schema.String,
    recipient: Schema.String,
    source: Schema.Literal("human@kernel"),
    messageSha256: Schema.String,
    acceptedIntoQueue: Schema.Literal(true),
    deliveredToAgent: Schema.Literal(false),
    status: Schema.Literals(["recorded", "idempotent"]),
    delivery: Schema.Literals(["queued", "verified", "indeterminate", "failed"]),
  }),
  Schema.Struct({
    outcome: Schema.Literals(["not_sent", "unknown", "unconfirmed"]),
    reason: Schema.String,
  }),
]);
export type DesktopOpenRigOperatorReplyResult = typeof DesktopOpenRigOperatorReplyResultSchema.Type;

/** Renderer names the selected inbox item and gate only. MAIN re-reads both, then asks the human natively. */
export const DesktopOpenRigReviewGateSelectionSchema = Schema.Struct({
  destination: Schema.Literal("human@kernel"),
  qitemId: Schema.String,
  gateQitemId: Schema.String,
});
export type DesktopOpenRigReviewGateSelection = typeof DesktopOpenRigReviewGateSelectionSchema.Type;
export const DesktopOpenRigReviewGateResolveInputSchema = Schema.Struct({
  destination: Schema.Literal("human@kernel"),
  qitemId: Schema.String,
  gateQitemId: Schema.String,
  reviewId: Schema.String,
  reviewRevision: Schema.String,
  verdict: Schema.Literals(OPENRIG_REVIEW_GATE_VERDICTS),
  requestId: Schema.String,
  note: Schema.optional(Schema.String),
});
export type DesktopOpenRigReviewGateResolveInput =
  typeof DesktopOpenRigReviewGateResolveInputSchema.Type;
/** `gateReleased` is durable; `delivery` is the transport status, not proof of agent consumption. */
export const DesktopOpenRigReviewGateResolveResultSchema = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("released"),
    requestId: Schema.String,
    gateQitemId: Schema.String,
    reviewId: Schema.String,
    reviewRevision: Schema.String,
    verdict: Schema.Literals(OPENRIG_REVIEW_GATE_VERDICTS),
    status: Schema.Literals(["recorded", "idempotent"]),
    gateReleased: Schema.Literal(true),
    delivery: Schema.Literals(["verified", "queued", "indeterminate", "failed"]),
    wakeIntentDurable: Schema.Boolean,
  }),
  Schema.Struct({
    outcome: Schema.Literals(["not_sent", "cancelled", "unknown", "unconfirmed"]),
    reason: Schema.String,
  }),
]);
export type DesktopOpenRigReviewGateResolveResult =
  typeof DesktopOpenRigReviewGateResolveResultSchema.Type;

export interface DesktopChatGPTDraftSnapshotInput {
  readonly sessionId: string;
  readonly url: string;
  readonly draft: string;
  readonly uncertainSend: {
    readonly text: string;
    readonly original: string;
    readonly url: string;
    readonly before: { readonly totalTurns: number; readonly lastUserTurnKey: string | null };
    readonly policyEnrichment: {
      readonly schema: "t3-c05-browser-optional/v1";
      readonly status: "deferred" | "not_eligible" | "prepared" | "observed_user_turn";
      readonly reason?: string | undefined;
      readonly qitemIds?: readonly string[] | undefined;
    };
  } | null;
}

export interface DesktopChatGPTDraftSnapshotReceipt {
  readonly sessionId: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly path: string;
  readonly uncertainSendPresent: boolean;
}

export interface DesktopBridge {
  /** One-shot read of OmniHub's locally persisted temporary keep-awake monitors. */
  readOmniHubKeepAwakeMonitors?: (
    input: import("./omniHubKeepAwake.ts").DesktopOmniHubKeepAwakeQuery,
  ) => Promise<import("./omniHubKeepAwake.ts").DesktopOmniHubKeepAwakeReadResult>;
  /** Applies owner-token-authorized changes through OmniHub Tools; tokens never enter UI. */
  controlOmniHubKeepAwakeMonitor?: (
    input: import("./omniHubKeepAwake.ts").DesktopOmniHubKeepAwakeControlQuery,
  ) => Promise<import("./omniHubKeepAwake.ts").DesktopOmniHubKeepAwakeControlReceipt>;
  /** Read-only local TaskBoard Done evidence; unavailable on non-desktop clients. */
  readTaskBoardWorkerClaims?: () => Promise<
    readonly {
      taskId: string;
      claimedBy: string;
      column: string;
      completedAt: number | null;
    }[]
  >;
  /** Local desktop-only private backup: raw draft and pending send never return over activation IPC. */
  savePrivateChatGPTDraftSnapshot?: (
    input: DesktopChatGPTDraftSnapshotInput,
  ) => Promise<DesktopChatGPTDraftSnapshotReceipt>;
  getAppBranding: () => DesktopAppBranding | null;
  /** Absolute path of a dropped or picked file; absent on desktop builds predating it. */
  getPathForFile?: (file: File) => string;
  /** The desktop client's OS platform, read from Electron's preload process. */
  getClientPlatform?: () => string;
  setNotificationBadge?: (badge: { count: number; image: string | null }) => Promise<void>;
  onNotificationBadgeClear?: (listener: () => void) => () => void;
  onTrackpadScrollEnd?: (listener: () => void) => () => void;
  /**
   * The OS locale as a BCP-47 tag, which the renderer cannot read for itself:
   * the packaged app ships only the `en-US` Chromium locale pak, so
   * `navigator.language` and the default `Intl` locale are pinned to `en-US`
   * regardless of OS settings.
   */
  getSystemLocale?: () => string | null;
  // One bootstrap per pool instance currently registered with bootstrap
  // info (omits instances whose backend hasn't produced a config yet).
  // The primary backend is identified by id === PRIMARY_LOCAL_ENVIRONMENT_ID.
  getLocalEnvironmentBootstraps: () => readonly DesktopEnvironmentBootstrap[];
  getLocalEnvironmentEnabled?: () => boolean;
  setLocalEnvironmentEnabled?: (enabled: boolean) => Promise<void>;
  getLocalEnvironmentBearerToken: () => Promise<string>;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  /** Only available in desktop builds with the local OpenRig integration. */
  listOpenRigAgents?: () => Promise<readonly DesktopOpenRigAgent[]>;
  listPendingOpenRigNativeApprovals?: () => Promise<DesktopOpenRigNativeApprovalPage>;
  getOpenRigNativeApproval?: (operationId: string) => Promise<DesktopOpenRigNativeApproval>;
  /** Opens an OS-native review; renderer supplies lookup ID only, never choice or proof. */
  requestOpenRigNativeReview?: (operationId: string) => Promise<DesktopOpenRigNativeReviewResult>;
  readOpenRigOperatorInbox?: (address: string) => Promise<DesktopOpenRigInbox>;
  readTaskBoardHumanInbox?: () => Promise<{ items: Array<{ sourceKey: string; sourceId: string; boardRoot?: string; title: string; body?: string; createdAt?: string }>; sources: Array<{ source: "taskboard"; id: string; status: "available" | "unavailable"; error?: string }> }>;
  openTaskBoardHumanItem?: (input: { boardRoot: string; taskId: string }) => Promise<{ launched: true; sourceKey: string }>;
  /** Runs the locally installed AISpeak preview (max 20 spoken words). */
  speakOpenRigPreview?: (text: string) => Promise<void>;
  submitOpenRigHumanResponse?: (
    input: DesktopOpenRigHumanResponseInput,
  ) => Promise<DesktopOpenRigHumanResponseResult>;
  sendOpenRigOperatorReply?: (
    input: DesktopOpenRigOperatorReplyInput,
  ) => Promise<DesktopOpenRigOperatorReplyResult>;
  reconcileOpenRigOperatorReply?: (
    input: DesktopOpenRigOperatorReplyInput,
  ) => Promise<DesktopOpenRigOperatorReplyResult>;
  /** MAIN opens the review URL it re-read from OpenRig; the renderer never supplies a URL. */
  openOpenRigReviewGate?: (input: DesktopOpenRigReviewGateSelection) => Promise<boolean>;
  /** MAIN re-validates the selected gate and shows a native confirmation before any POST. */
  resolveOpenRigReviewGate?: (
    input: DesktopOpenRigReviewGateResolveInput,
  ) => Promise<DesktopOpenRigReviewGateResolveResult>;
  /** Read-only receipt lookup for an UNKNOWN resolve; never re-POSTs. */
  reconcileOpenRigReviewGate?: (
    input: DesktopOpenRigReviewGateResolveInput,
  ) => Promise<DesktopOpenRigReviewGateResolveResult>;
  listOpenRigSessions?: () => Promise<readonly DesktopOpenRigSession[]>;
  listOpenRigManagedSessions?: (seatId: string) => Promise<DesktopOpenRigSeatSessions>;
  discoverOpenRigSeats?: () => Promise<DesktopOpenRigSeatTopology>;
  readOpenRigSeatReports?: (seatId: string) => Promise<DesktopOpenRigSeatReports>;
  readOpenRigAgentTasks?: (agentId: string) => Promise<DesktopOpenRigAgentTasks>;
  readOpenRigPolicyForBrowserSend?: (
    input: DesktopOpenRigPolicyIntakeInput,
  ) => Promise<DesktopOpenRigPolicyIntakeResult>;
  readOpenRigExecutionProfile?: (seatId: string) => Promise<DesktopOpenRigExecutionProfile>;
  configureOpenRigExecutionProfile?: (
    input: DesktopOpenRigConfigureExecutionProfileInput,
  ) => Promise<DesktopOpenRigExecutionProfile>;
  startOpenRigManagedSession?: (
    input: DesktopOpenRigLaunchInput,
  ) => Promise<DesktopOpenRigSeatSessions>;
  selectOpenRigPrimarySession?: (
    input: DesktopOpenRigPrimaryInput,
  ) => Promise<DesktopOpenRigSeatSessions>;
  adoptOpenRigManagedSession?: (
    input: DesktopOpenRigAdoptInput,
  ) => Promise<DesktopOpenRigSeatSessions>;
  reconcileOpenRigChatGPTManagedSession?: (
    input: DesktopOpenRigSessionActionInput,
  ) => Promise<DesktopOpenRigSeatSessions>;
  detachOpenRigManagedSession?: (
    input: DesktopOpenRigSessionActionInput,
  ) => Promise<DesktopOpenRigSeatSessions>;
  runOpenRigManagedBrowserLifecycle?: (
    input: DesktopOpenRigManagedBrowserLifecycleInput,
  ) => Promise<DesktopOpenRigManagedBrowserLifecycleResult>;
  bindOpenRigAgent?: (input: DesktopOpenRigBindInput) => Promise<void>;
  unbindOpenRigAgent?: (id: string) => Promise<void>;
  sendOpenRigAgentMessage?: (input: DesktopOpenRigSendInput) => Promise<void>;
  getConnectionCatalog?: () => Promise<string | null>;
  setConnectionCatalog?: (catalog: string) => Promise<boolean>;
  clearConnectionCatalog?: () => Promise<void>;
  discoverSshHosts: () => Promise<readonly DesktopDiscoveredSshHost[]>;
  /** Resolves a suggested SSH alias before populating the connection form. */
  resolveSshHost: (alias: string) => Promise<DesktopSshEnvironmentTarget>;
  requestSnapShotPermissions?: (includeAccessibility: boolean) => Promise<void>;
  getSnapShotState?: () => Promise<DesktopSnapShotState>;
  setupSnapShot?: (action: DesktopSnapShotSetupAction) => Promise<void>;
  previewSnapShotConfig?: (
    request: DesktopCaptureConfigRequest,
  ) => Promise<DesktopCaptureConfigPreview | null>;
  applySnapShotConfig?: (previewId: string) => Promise<DesktopCaptureConfigApplied>;
  checkSnapShotShortcut?: (
    shortcut: SnapShotShortcut,
  ) => Promise<DesktopSnapShotShortcutAvailability>;
  setSnapShotShortcutSuppressed?: (suppressed: boolean) => Promise<void>;
  listPendingSnapShots?: () => Promise<readonly DesktopPendingSnapShot[]>;
  readSnapShot?: (id: string) => Promise<DesktopSnapShot>;
  setSnapShotAnimationDestination?: (
    destination: DesktopSnapShotAnimationDestination,
  ) => Promise<void>;
  dismissSnapShotAnimation?: (id: DesktopSnapShotId) => Promise<void>;
  acknowledgeSnapShot?: (id: string) => Promise<void>;
  ensureSshEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { issuePairingToken?: boolean },
  ) => Promise<DesktopSshEnvironmentBootstrap>;
  disconnectSshEnvironment: (target: DesktopSshEnvironmentTarget) => Promise<void>;
  fetchSshEnvironmentDescriptor: (httpBaseUrl: string) => Promise<ExecutionEnvironmentDescriptor>;
  bootstrapSshBearerSession: (
    httpBaseUrl: string,
    credential: string,
  ) => Promise<AuthAccessTokenResult>;
  fetchSshSessionState: (httpBaseUrl: string, bearerToken: string) => Promise<AuthSessionState>;
  issueSshWebSocketTicket: (
    httpBaseUrl: string,
    bearerToken: string,
  ) => Promise<AuthWebSocketTicketResult>;
  onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => () => void;
  resolveSshPasswordPrompt: (requestId: string, password: string | null) => Promise<void>;
  getServerExposureState: () => Promise<DesktopServerExposureState>;
  setServerExposureMode: (mode: DesktopServerExposureMode) => Promise<DesktopServerExposureState>;
  setTailscaleServeEnabled: (input: {
    readonly enabled: boolean;
    readonly port?: number;
  }) => Promise<DesktopServerExposureState>;
  getAdvertisedEndpoints: () => Promise<readonly AdvertisedEndpoint[]>;
  getWslState: () => Promise<DesktopWslState>;
  setWslBackendEnabled: (enabled: boolean) => Promise<DesktopWslState>;
  setWslDistro: (distro: string | null) => Promise<DesktopWslState>;
  setWslOnly: (enabled: boolean) => Promise<DesktopWslState>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  /** Optional while older desktop shells can host a newer web client. */
  pickProjectFavicon?: (initialPath?: string) => Promise<string | null>;
  /**
   * Multi-select JSON file picker that opens in the VS Code extensions
   * directory when one exists. Optional: older desktop builds lack it, and
   * web callers fall back to a plain file input.
   */
  pickThemeFiles?: () => Promise<readonly PickedThemeFile[] | null>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  /** Receives a local OAuth code for a sign-in owned by a remote environment. */
  receiveProviderAuthCallback?: (authorizationUrl: string) => Promise<string>;
  cancelProviderAuthCallback?: (authorizationUrl: string) => Promise<void>;
  openExternal: (url: string) => Promise<boolean>;
  /**
   * Open a System Settings pane by identifier. Optional: older desktop builds
   * lack it, and callers no-op when it is missing.
   */
  openSystemSettings?: (pane: SystemSettingsPane) => Promise<boolean>;
  checkSystemPermission?: (pane: SystemSettingsPane) => Promise<boolean>;
  /**
   * Probe this desktop machine for installed remote-capable editor CLIs
   * (used for remote open-in-editor deep links). Optional: older desktop
   * builds lack it; callers fall back to VS Code only.
   */
  probeRemoteEditors?: () => Promise<readonly EditorId[]>;
  /** Present when the desktop shell can perform an ordered plain-text paste. */
  pasteAsText?: () => Promise<void>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  onSnapShotEvent?: (listener: (event: DesktopSnapShotEvent) => void) => () => void;
  /**
   * Quit-confirmation hint pushes. Optional: older desktop builds never emit
   * them.
   */
  onQuitShortcut?: (listener: (event: QuitShortcutHintEvent) => void) => () => void;
  getWindowFullscreenState: () => boolean;
  onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  /** Settings → `t3` command. Optional: older desktop builds lack it. */
  cliCommand?: {
    getState: () => Promise<DesktopCliCommandState>;
    install: () => Promise<DesktopCliCommandState>;
    uninstall: () => Promise<DesktopCliCommandState>;
  };
  /** Present when the desktop shell accepts `t3 app` activation requests. */
  /**
   * Web links the OS opens with T3 Code as the default browser (macOS). The
   * renderer reports when it listens; links queue in the main process until then.
   */
  webLinks?: {
    setReady: (ready: boolean) => Promise<void>;
    onOpen: (listener: (url: string) => void) => () => void;
  };
  appActivation?: {
    setReady: (ready: boolean) => Promise<void>;
    complete: (response: DesktopAppActivationResponse) => Promise<void>;
    enqueueChatGPT: (input: { messageId: string; sessionId: string;
      conversationId: string; body: string }) => Promise<{
        messageId: string; sessionId: string; conversationId: string; status: string;
        attempts: number; createdAt: number; updatedAt: number; lastError?: string;
      }>;
    onRequest: (listener: (request: DesktopAppActivationRequest) => void) => () => void;
  };
  /**
   * Desktop-only preview surface. Present iff the renderer is hosted by the
   * Electron desktop build; web builds have `preview === undefined`.
   */
  preview?: DesktopPreviewBridge;
}

/** Renderer callback invoked by Electron with a fresh user gesture before display-media capture. */
export const DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER = "__t3DesktopPreviewRecordingCapture";

export interface DesktopPreviewBridge {
  setForwardedShortcuts?: (shortcuts: ReadonlyArray<PreviewForwardedShortcut>) => Promise<void>;
  createTab: (tabId: string, defaults?: DesktopPreviewTabDefaults) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  registerWebview: (tabId: string, webContentsId: number) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  goBack: (tabId: string) => Promise<void>;
  goForward: (tabId: string) => Promise<void>;
  refresh: (tabId: string) => Promise<void>;
  zoomIn: (tabId: string) => Promise<void>;
  zoomOut: (tabId: string) => Promise<void>;
  resetZoom: (tabId: string) => Promise<void>;
  /** Sets a tab's zoom to the factor its environment published, for tabs the server drives. */
  setZoomFactor: (tabId: string, zoomFactor: number) => Promise<void>;
  /** Reload bypassing the HTTP cache. */
  hardReload: (tabId: string) => Promise<void>;
  /**
   * Emulate `prefers-color-scheme` on the guest page ("system" clears the
   * override). Persists per tab and is re-applied across webview swaps.
   */
  setColorScheme: (tabId: string, colorScheme: DesktopPreviewColorScheme) => Promise<void>;
  /**
   * Silence the tab's audio output. Persists per tab and is re-applied across
   * webview swaps, but is dropped when the tab closes. Muting a silent tab is
   * allowed; it simply takes effect once the page plays something.
   */
  setAudioMuted: (tabId: string, audioMuted: boolean) => Promise<void>;
  /** Open the guest webview's DevTools (detached). */
  openDevTools: (tabId: string) => Promise<void>;
  /** Drop cookies + storage data for the preview partition (all tabs). */
  clearCookies: (environmentId: EnvironmentId, profileId?: string) => Promise<void>;
  /** Drop the HTTP cache for the preview partition (all tabs). */
  clearCache: (environmentId: EnvironmentId, profileId?: string) => Promise<void>;
  /**
   * One-shot config for mounting a preview `<webview>`. Replaces three
   * earlier round-trip calls (`getBrowserPartition`, `getWebviewPreferences`,
   * `getPickPreloadPath`) so adding a new field here only requires touching
   * the contract + main, not the renderer's mount logic.
   */
  getPreviewConfig: (
    environmentId: EnvironmentId,
    profileId?: string,
  ) => Promise<DesktopPreviewWebviewConfig>;
  /** Browsers on this machine whose cookies can be imported. */
  listBrowserImportSources: () => Promise<ReadonlyArray<BrowserImportSource>>;
  importBrowserCookies: (input: {
    readonly environmentId: EnvironmentId;
    readonly sourceId: BrowserImportSourceId;
    readonly sourceProfileDirectory: string;
    readonly targetProfileId: string;
  }) => Promise<BrowserImportResult>;
  setAnnotationTheme: (theme: DesktopPreviewAnnotationTheme) => Promise<void>;
  /** Keep an open annotation picker's send shortcut in sync with its thread grant. */
  setAnnotationSendEnabled: (tabId: string, enabled: boolean) => Promise<void>;
  /**
   * Activate the in-page element picker for the given tab. Resolves with
   * the picked annotation and its attach/send intent, or `null` when the
   * user cancels (Escape / nav). The promise rejects if the picker can't be
   * activated (no webview, etc.).
   */
  pickElement: (tabId: string) => Promise<PreviewAnnotationSubmissionResult | null>;
  /** Cancel an in-flight preview annotation session. */
  cancelPickElement: (tabId: string) => Promise<void>;
  captureScreenshot: (tabId: string) => Promise<DesktopPreviewScreenshotArtifact>;
  revealArtifact: (path: string) => Promise<void>;
  copyArtifactToClipboard: (path: string) => Promise<void>;
  pictureInPicture: {
    open: (tabId: string) => Promise<void>;
    close: (tabId: string) => Promise<void>;
  };
  recording: {
    onInput: (listener: (event: DesktopPreviewRecordingInputEvent) => void) => () => void;
    startScreencast: (tabId: string) => Promise<void>;
    stopScreencast: (tabId: string) => Promise<void>;
    save: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Promise<DesktopPreviewRecordingArtifact>;
    onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => () => void;
  };
  onStateChange: (listener: (tabId: string, state: DesktopPreviewTabState) => void) => () => void;
  onPointerEvent: (listener: (event: DesktopPreviewPointerEvent) => void) => () => void;
  onOpenLink: (listener: (event: DesktopPreviewOpenLinkEvent) => void) => () => void;
}

export type ConfirmDialogVariant = "default" | "destructive";

export interface ConfirmDialogOptions {
  readonly variant?: ConfirmDialogVariant;
}

/**
 * APIs bound to the local app shell, not to any particular backend environment.
 *
 * These capabilities describe the desktop/browser host that the user is
 * currently running: dialogs, external-link opening, context menus, and
 * app-level settings/config access. They must not be used as a proxy for
 * "whatever environment the user is targeting", because in a multi-environment
 * world the local shell and a selected backend environment are distinct
 * concepts.
 */
export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string, options?: ConfirmDialogOptions) => Promise<boolean>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
    /** Opens a known System Settings pane; no-ops outside the desktop app. */
    openSystemSettings: (pane: SystemSettingsPane) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
    close: () => Promise<void>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
  };
}
