import * as Schema from "effect/Schema";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  t3Home: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  // Present when the desktop rotates the renderer's bootstrap token: the
  // backend derives the accepted tokens from this secret instead of trusting
  // `desktopBootstrapToken` for its whole run. See
  // `@t3tools/shared/desktopBootstrapToken`.
  desktopBootstrapSecret: Schema.optionalKey(Schema.String),
  // Set only when the desktop already merged the user's shell environment into
  // the environment it hands this backend. Absent means the backend hydrates
  // PATH itself, which WSL and older desktops rely on.
  shellEnvironmentPrepared: Schema.optionalKey(Schema.Boolean),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  otlpLogsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  /** Desktop -> server: the desktop's browser tabs, as newline-delimited JSON. */
  desktopBrowserFd: Schema.optionalKey(PositiveInt),
  /** Server -> desktop: commands for those tabs. */
  desktopBrowserControlFd: Schema.optionalKey(PositiveInt),
  /** INACTIVE W2-A only: server -> Windows MAIN private authority output. */
  desktopPrivateAuthorityOutputFd: Schema.optionalKey(Schema.Literal(8)),
  /** INACTIVE W2-A only: Windows MAIN -> server private challenge input. */
  desktopPrivateAuthorityInputFd: Schema.optionalKey(Schema.Literal(9)),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

/** Negative-only opt-in. Partial/colliding pairs MUST NEVER become a channel. */
export function inactivePrivateAuthorityFdPair(
  bootstrap: Pick<
    DesktopBackendBootstrap,
    | "desktopPrivateAuthorityOutputFd"
    | "desktopPrivateAuthorityInputFd"
    | "desktopTelemetryFd"
    | "desktopTelemetryControlFd"
    | "desktopBrowserFd"
    | "desktopBrowserControlFd"
  >,
): { readonly outputFd: 8; readonly inputFd: 9 } | null {
  if (
    bootstrap.desktopPrivateAuthorityOutputFd !== 8 ||
    bootstrap.desktopPrivateAuthorityInputFd !== 9
  )
    return null;
  const occupied = [
    3,
    bootstrap.desktopTelemetryFd,
    bootstrap.desktopTelemetryControlFd,
    bootstrap.desktopBrowserFd,
    bootstrap.desktopBrowserControlFd,
  ].filter((fd): fd is number => fd !== undefined);
  if (new Set(occupied).size !== occupied.length || occupied.includes(8) || occupied.includes(9))
    return null;
  return { outputFd: 8, inputFd: 9 };
}

/** Written to `<t3Home>/runtime` just before the desktop app stops its
    backend to install an update. The updated app starts a new backend right
    away, so a backend that sees a fresh marker at shutdown keeps its managed
    tunnel. */
export const DESKTOP_UPDATE_RESTART_MARKER_FILE = "desktop-update-restart";
