"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "openid",
  "email",
];
const MAX_FILE_BYTES = 28 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;
const AUTH_TIMEOUT_MS = 180_000;
const VALID_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

const base64url = buffer => Buffer.from(buffer).toString("base64url");
function normalizeClient(json) {
  const c = json?.installed;
  if (!c || typeof c.client_id !== "string" ||
      !/^[a-zA-Z0-9_.-]+\.apps\.googleusercontent\.com$/.test(c.client_id) ||
      typeof c.client_secret !== "string" || c.client_secret.length > 300) {
    throw Error("Choose Google OAuth JSON credentials for a Desktop (installed) application.");
  }
  return { client_id: c.client_id, client_secret: c.client_secret };
}
async function readSmallJson(file, maxBytes = 8192) {
  const stat = await fs.stat(file);
  if (stat.size > maxBytes) throw Error("OAuth configuration file too large.");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
function googleFileId(id) {
  if (typeof id !== "string" || !VALID_FILE_ID.test(id)) throw Error("Invalid Google file ID.");
  return id;
}
function googleRange(range) {
  if (typeof range !== "string" || range.length > 250 ||
      !/^[\w .'-]+![A-Z]{1,3}[1-9]\d*(?::[A-Z]{1,3}[1-9]\d*)?$/.test(range)) {
    throw Error("Invalid Google Sheets cell range.");
  }
  return range;
}
function createGoogleWorkspace({ userDataDir, safeStorage, openExternal, fetchImpl = fetch }) {
  const configFile = path.join(userDataDir, "google-oauth-client.json");
  const tokenFile = path.join(userDataDir, "google-oauth-token.bin");
  let inProgress = false;
  const fetchLimited = async (uri, options) => {
    const result = await fetchImpl(uri, {
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...options,
    });
    if (!result.ok) {
      // Do not leak access tokens, returned HTML, or broad document content into errors.
      throw Error(`Google API returned HTTP ${result.status}.`);
    }
    return result;
  };
  const readClient = async () => normalizeClient(await readSmallJson(configFile));
  const readToken = async () => {
    if (!safeStorage.isEncryptionAvailable()) throw Error("Windows secure token storage unavailable.");
    try {
      const content = await fs.readFile(tokenFile);
      return JSON.parse(safeStorage.decryptString(content));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw Error("Google session could not be decrypted. Sign in again.");
    }
  };
  const writeToken = async token => {
    if (!safeStorage.isEncryptionAvailable()) throw Error("Secure token storage unavailable.");
    await fs.mkdir(userDataDir, { recursive: true });
    const temporary = tokenFile + "." + crypto.randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(token)));
      await fs.rename(temporary, tokenFile);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  };
  const tokenRequest = async params => {
    const result = await fetchLimited("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const payload = await result.json();
    if (!payload.access_token) throw Error("Google did not return an access token.");
    return payload;
  };
  const getAccessToken = async () => {
    const token = await readToken();
    if (!token) throw Error("Google Workspace is not connected.");
    if (token.expires_at > Date.now() + 90_000) return token.access_token;
    if (!token.refresh_token) throw Error("Google session expired. Sign in again.");
    const client = await readClient();
    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    const next = {
      ...token, ...refreshed,
      refresh_token: refreshed.refresh_token ?? token.refresh_token,
      expires_at: Date.now() + refreshed.expires_in * 1000,
    };
    await writeToken(next);
    return next.access_token;
  };
  const googleRequest = async (uri, options = {}) => {
    const url = new URL(uri);
    if (url.protocol !== "https:" ||
        !["www.googleapis.com", "sheets.googleapis.com", "docs.googleapis.com"].includes(url.hostname)) {
      throw Error("Google API endpoint not allowed.");
    }
    const token = await getAccessToken();
    return fetchLimited(url.href, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    });
  };

  return {
    async clientStatus() {
      const configured = await fs.stat(configFile).then(() => true, () => false);
      const session = await readToken().catch(() => null);
      return { configured, connected: !!session?.refresh_token || !!(session?.access_token && session.expires_at > Date.now()), scopes: configured ? SCOPES : [] };
    },
    async configure(file) {
      const config = normalizeClient(await readSmallJson(file));
      await fs.mkdir(userDataDir, { recursive: true });
      // Client registration is public desktop-app configuration, not an account
      // token. Account tokens stay under Electron's encrypted safeStorage.
      await fs.writeFile(configFile, JSON.stringify({ installed: config }), { mode: 0o600 });
      await fs.rm(tokenFile, { force: true });
      return { configured: true, connected: false };
    },
    async signIn() {
      if (inProgress) throw Error("Google sign-in is already running.");
      const client = await readClient();
      if (!safeStorage.isEncryptionAvailable()) throw Error("Cannot store tokens securely on this computer.");
      inProgress = true;
      const state = base64url(crypto.randomBytes(28));
      const verifier = base64url(crypto.randomBytes(32));
      const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
      let server;
      let authTimer;
      try {
        const codePromise = new Promise((resolve, reject) => {
          server = http.createServer((req, res) => {
            if (req.method !== "GET" || !req.url) { res.writeHead(404).end(); return; }
            const request = new URL(req.url, "http://127.0.0.1");
            if (request.pathname !== "/google-auth-callback") { res.writeHead(404).end(); return; }
            if (request.searchParams.get("state") !== state) {
              res.writeHead(403).end("Invalid authorization state");
              return;
            }
            const code = request.searchParams.get("code");
            if (!code) {
              res.writeHead(400).end("Google sign-in cancelled.");
              reject(Error("Google authorization was cancelled."));
              return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
              .end("<!doctype html><title>Monku connected</title><p>Google Workspace connected to Monku. You can close this tab.</p>");
            resolve(code);
          });
          server.once("error", reject);
        });
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const port = server.address().port;
        const redirect = `http://127.0.0.1:${port}/google-auth-callback`;
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        for (const [key, value] of Object.entries({
          client_id: client.client_id, redirect_uri: redirect,
          response_type: "code", scope: SCOPES.join(" "),
          access_type: "offline", prompt: "consent",
          state, code_challenge: challenge, code_challenge_method: "S256",
        })) url.searchParams.set(key, value);
        await openExternal(url.href);
        const code = await Promise.race([
          codePromise,
          new Promise((_, reject) => { authTimer = setTimeout(() => reject(Error("Google sign-in timed out.")), AUTH_TIMEOUT_MS); }),
        ]);
        const credentials = await tokenRequest({
          code, grant_type: "authorization_code", redirect_uri: redirect,
          code_verifier: verifier,
          client_id: client.client_id, client_secret: client.client_secret,
        });
        await writeToken({ ...credentials, expires_at: Date.now() + credentials.expires_in * 1000 });
        return { connected: true };
      } finally {
        if (authTimer) clearTimeout(authTimer);
        server?.close();
        inProgress = false;
      }
    },
    async logout() {
      await fs.rm(tokenFile, { force: true });
      return { connected: false };
    },
    async listFiles(pageToken) {
      const query = new URL("https://www.googleapis.com/drive/v3/files");
      query.searchParams.set("q", "(mimeType='application/vnd.google-apps.spreadsheet' or mimeType='application/vnd.google-apps.document') and trashed = false");
      query.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime)");
      query.searchParams.set("orderBy", "modifiedTime desc");
      query.searchParams.set("pageSize", "100");
      if (pageToken) {
        if (typeof pageToken !== "string" || pageToken.length > 1200) throw Error("Invalid Google Drive paging token.");
        query.searchParams.set("pageToken", pageToken);
      }
      const result = await googleRequest(query.href);
      const data = await result.json();
      return {
        files: (data.files ?? []).filter(f => VALID_FILE_ID.test(f.id) && typeof f.name === "string"),
        nextPageToken: data.nextPageToken ?? null,
      };
    },
    async sheetInfo(fileId) {
      const id = googleFileId(fileId);
      const result = await googleRequest(
        `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=spreadsheetId,properties(title),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`
      );
      const body = await result.json();
      return { id, title: body.properties?.title ?? "",
        sheets: (body.sheets ?? []).map(s => ({
          gid: s.properties?.sheetId, title: s.properties?.title ?? "",
          rowCount: s.properties?.gridProperties?.rowCount ?? 0,
        })).filter(s => Number.isInteger(s.gid) && !!s.title) };
    },
    async createCopy(fileId, newName) {
      const id = googleFileId(fileId);
      if (typeof newName !== "string" || !newName.trim() || newName.length > 180) throw Error("Invalid copy name.");
      const result = await googleRequest(`https://www.googleapis.com/drive/v3/files/${id}/copy?fields=id,name,mimeType,webViewLink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      const data = await result.json();
      return { id: googleFileId(data.id), name: data.name, mimeType: data.mimeType };
    },
    async exportFile(fileId, kind) {
      const id = googleFileId(fileId);
      const mime = kind === "sheet" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : kind === "doc" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : null;
      if (!mime) throw Error("Only Google Docs and Sheets exports are supported.");
      const url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(mime)}`;
      const response = await googleRequest(url);
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_FILE_BYTES) throw Error("Google export too large. Maximum is 28 MiB.");
      const content = Buffer.from(await response.arrayBuffer());
      if (content.byteLength > MAX_FILE_BYTES) throw Error("Google export too large.");
      return { data: content.toString("base64"), extension: kind === "sheet" ? "xlsx" : "docx" };
    },
    async readSheetValues(fileId, range) {
      const id = googleFileId(fileId);
      googleRange(range);
      const uri = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}`;
      const response = await googleRequest(uri);
      const data = await response.json();
      return { range: data.range, values: data.values ?? [] };
    },
    // Caller supplies only explicit A1 ranges. Never write to original files:
    // only IDs recorded in the own-copy manifest can be used.
    async writeCopiesOnly(fileId, updates) {
      const id = googleFileId(fileId);
      if (!Array.isArray(updates) || !updates.length || updates.length > 4000 ||
          !updates.every(u => u && googleRange(u.range) && Array.isArray(u.values) &&
            u.values.length <= 2 && u.values.every(row => Array.isArray(row) && row.every(c => typeof c === "string" && c.length <= 20000)))) {
        throw Error("Invalid Google Sheets update batch.");
      }
      const authorizedCopies = await fs.readFile(path.join(userDataDir, "google-owned-copies.json"), "utf8")
        .then(JSON.parse, () => []);
      if (!authorizedCopies.includes(id)) throw Error("Refusing to write to a Google file not copied by Monku.");
      const response = await googleRequest(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valueInputOption: "RAW", data: updates }),
      });
      const data = await response.json();
      return { updatedCells: data.totalUpdatedCells ?? 0, updatedRanges: data.totalUpdatedSheets ?? 0 };
    },
    async writeCheckedCopy(fileId, checks) {
      const id = googleFileId(fileId);
      if (!Array.isArray(checks) || checks.length === 0 || checks.length > 200 ||
          !checks.every(c => c && typeof c.expected === "string" && typeof c.next === "string" &&
            c.next.length <= 20000 && googleRange(c.range))) throw Error("Invalid checked sync batch.");
      const authorized = await fs.readFile(path.join(userDataDir, "google-owned-copies.json"), "utf8").then(JSON.parse, () => []);
      if (!authorized.includes(id)) throw Error("Only Monku-created Google copies may be synchronized.");
      // The read/compare is a preflight: Google Sheets does not provide an atomic
      // compare-and-set API. Recheck immediately before submission and disclose this limit.
      const readUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet`);
      for (const item of checks) readUrl.searchParams.append("ranges", item.range);
      readUrl.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
      const actual = await (await googleRequest(readUrl.href)).json();
      if (!Array.isArray(actual.valueRanges) || actual.valueRanges.length !== checks.length) throw Error("Google returned an incomplete sync preflight; no edits were sent.");
      const conflicts = checks.flatMap((item, index) => {
        const data = actual.valueRanges[index];
        const observed = data?.values?.[0]?.[0] ?? "";
        return observed === item.expected ? [] : [{ range: item.range, expected: item.expected, actual: String(observed).slice(0, 300) }];
      });
      if (conflicts.length) return { updatedCells: 0, conflicts };
      const updates = checks.map(item => ({ range: item.range, values: [[item.next]] }));
      const response = await googleRequest(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ valueInputOption: "RAW", data: updates }),
      });
      const outcome = await response.json();
      return { updatedCells: outcome.totalUpdatedCells ?? 0, conflicts: [] };
    },
    async registerCopy(fileId) {
      const id = googleFileId(fileId);
      const filename = path.join(userDataDir, "google-owned-copies.json");
      const existing = await fs.readFile(filename, "utf8").then(JSON.parse, () => []);
      if (!existing.includes(id)) {
        await fs.mkdir(userDataDir, { recursive: true });
        await fs.writeFile(filename, JSON.stringify([...existing, id]));
      }
    },
  };
}
module.exports = { createGoogleWorkspace, normalizeClient, googleFileId, googleRange };
