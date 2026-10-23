/**
 * W2-A *negative-only* MAIN-side one-use server challenge/ACK verification.
 * This is NOT an enrolled lease or OpenRig host witness. MAIN will need to
 * bind an independently held W1 child HANDLE and inherited FD channel before
 * ever using a positive bridge; no production caller instantiates this gate.
 */
export function makeInactiveMainChallengeGate(input: {
  readonly mainRunId: string;
  readonly serverGenerationId: string;
  readonly serverChannelIncarnationId: string;
  readonly challengeId: string;
  readonly nonce: string;
  readonly begunAtMs: number;
  readonly now: () => number;
}) {
  if (
    ![
      input.mainRunId,
      input.serverGenerationId,
      input.serverChannelIncarnationId,
      input.challengeId,
    ].every((value) => /^[A-Za-z0-9_:-]{1,128}$/.test(value)) ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.nonce) ||
    !Number.isSafeInteger(input.begunAtMs)
  )
    throw new Error("Invalid W2-A challenge correlation");
  let state: "pending" | "acknowledged" | "revoked" = "pending";
  const challenge = {
    type: "challenge" as const,
    version: 1 as const,
    mainRunId: input.mainRunId,
    serverGenerationId: input.serverGenerationId,
    serverChannelIncarnationId: input.serverChannelIncarnationId,
    challengeId: input.challengeId,
    nonce: input.nonce,
  };
  const expected = {
    ...challenge,
    type: "challenge_ack" as const,
  };
  const outbound = JSON.stringify(challenge) + "\\n";
  if (Buffer.byteLength(outbound, "utf8") > 4096) throw new Error("Oversized W2-A challenge");
  return {
    challengeLine: outbound,
    get acknowledged() {
      return state === "acknowledged";
    },
    get revoked() {
      return state === "revoked";
    },
    close() {
      state = "revoked";
    },
    acceptAckLine(line: string): boolean {
      if (state !== "pending") {
        state = "revoked";
        return false;
      }
      if (
        input.now() < input.begunAtMs ||
        input.now() - input.begunAtMs >= 5000 ||
        Buffer.byteLength(line, "utf8") > 4096 ||
        line.includes("\\r") ||
        line.includes("\\n")
      ) {
        state = "revoked";
        return false;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        state = "revoked";
        return false;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        JSON.stringify(parsed) !== line
      ) {
        state = "revoked";
        return false;
      }
      const obj = parsed as Record<string, unknown>;
      const valid =
        Object.keys(obj).length === Object.keys(expected).length &&
        Object.entries(expected).every(([key, value]) => obj[key] === value);
      state = valid ? "acknowledged" : "revoked";
      return valid;
    },
  };
}
