"use strict";

// Public-sheet export through the desktop main process. Browser fetches from
// file:// are blocked by CORS; native access is restricted to Google domains.
// Private Google Workspace files require a separate OAuth integration.
const MAX_CSV_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const safeHost = hostname => hostname === "docs.google.com" ||
  hostname === "drive.google.com" ||
  hostname === "googleusercontent.com" ||
  hostname.endsWith(".googleusercontent.com");

function createPublicSheetReader(fetchImpl = globalThis.fetch) {
  return async (id, gid) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(id)) {
      throw new Error("Invalid Google Sheets document ID.");
    }
    if (gid !== undefined && (typeof gid !== "string" || !/^\d{1,18}$/.test(gid))) {
      throw new Error("Invalid Google Sheets tab ID.");
    }
    let uri = new URL(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`);
    const signal = AbortSignal.timeout(20_000);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (uri.protocol !== "https:" || !safeHost(uri.hostname)) {
        throw new Error("Google Sheets redirected outside its permitted export domain.");
      }
      const response = await fetchImpl(uri, { redirect: "manual", signal });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get("location");
        if (!next) throw new Error("Google Sheets redirect has no location.");
        uri = new URL(next, uri);
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new Error("Google Sheet is private. Public link access is required.");
      if (!response.ok) throw new Error(`Google Sheets returned HTTP ${response.status}.`);
      if (Number(response.headers.get("content-length") ?? 0) > MAX_CSV_BYTES) throw new Error("Google Sheet CSV is too large.");
      if (!response.body) throw new Error("Google Sheet returned no data.");
      const pieces = [];
      let length = 0;
      for await (const piece of response.body) {
        length += piece.byteLength;
        if (length > MAX_CSV_BYTES) {
          await response.body.cancel().catch(() => {});
          throw new Error("Google Sheet CSV exceeds the 12 MiB import limit.");
        }
        pieces.push(Buffer.from(piece));
      }
      return Buffer.concat(pieces).toString("utf8");
    }
    throw new Error("Google Sheets exceeded the redirect limit.");
  };
}

module.exports = { createPublicSheetReader, safeHost };
