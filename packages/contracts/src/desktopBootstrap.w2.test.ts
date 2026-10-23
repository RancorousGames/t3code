import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { DesktopBackendBootstrap, inactivePrivateAuthorityFdPair } from "./desktopBootstrap.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBackendBootstrap));
const base = {
  mode: "desktop",
  noBrowser: true,
  port: 4888,
  host: "127.0.0.1",
  desktopBootstrapToken: "test-only",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
  desktopTelemetryFd: 4,
  desktopTelemetryControlFd: 5,
  desktopBrowserFd: 6,
  desktopBrowserControlFd: 7,
} as const;

describe("W2-A negative-only optional desktop authority fd8/9 bootstrap", () => {
  it("leaves existing bootstrap without private authority by default", () => {
    const value = decode(JSON.stringify(base));
    assert.equal(inactivePrivateAuthorityFdPair(value), null);
    assert.isUndefined(value.desktopPrivateAuthorityInputFd);
    assert.isUndefined(value.desktopPrivateAuthorityOutputFd);
  });
  it("accepts only matched, collision-free 8/9 and never treats fields as enrollment", () => {
    const paired = decode(
      JSON.stringify({
        ...base,
        desktopPrivateAuthorityOutputFd: 8,
        desktopPrivateAuthorityInputFd: 9,
      }),
    );
    assert.deepEqual(inactivePrivateAuthorityFdPair(paired), { outputFd: 8, inputFd: 9 });
    assert.equal(
      inactivePrivateAuthorityFdPair({
        ...paired,
        desktopBrowserFd: 8,
      }),
      null,
    );
    assert.equal(
      inactivePrivateAuthorityFdPair({
        ...paired,
        desktopTelemetryFd: 5,
      }),
      null,
    );
    const partial = { ...paired };
    delete partial.desktopPrivateAuthorityOutputFd;
    assert.equal(inactivePrivateAuthorityFdPair(partial), null);
  });
  it("strict literal FDs forbid aliasing or reversed directions", () => {
    for (const pair of [
      [9, 8],
      [10, 11],
      [8, 10],
      [9, 9],
    ]) {
      assert.throws(() =>
        decode(
          JSON.stringify({
            ...base,
            desktopPrivateAuthorityOutputFd: pair[0],
            desktopPrivateAuthorityInputFd: pair[1],
          }),
        ),
      );
    }
  });
});
