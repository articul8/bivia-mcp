// @articul8/bivia-mcp — OAuth 2.1 + PKCE + Dynamic Client Registration &
// local credential store (~/.bivia/credentials.json).
//
// Zero runtime dependencies (Node 18+ built-ins only).
// Shares ~/.bivia/credentials.json with @articul8/bivia-cli and the Go `bivia` CLI.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_BASE = "https://api.articul8.ai/bivia";

export class OAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "OAuthError";
    this.code = code || "oauth_error";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function biviaConfigDir() {
  if (process.env.BIVIA_CONFIG_DIR) return process.env.BIVIA_CONFIG_DIR;
  return path.join(os.homedir(), ".bivia");
}

export function credentialsPath() {
  return path.join(biviaConfigDir(), "credentials.json");
}

export function credentialsLockPath() {
  return path.join(biviaConfigDir(), "credentials.lock");
}

export function oauthClientsPath() {
  return path.join(biviaConfigDir(), "oauth_clients.json");
}

export function configFilePath() {
  return path.join(biviaConfigDir(), "config");
}

export function normalizeExpiresAt(val) {
  const n = Number(val) || 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

async function acquireCredentialsLock() {
  const lockPath = credentialsLockPath();
  const dir = biviaConfigDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      };
    } catch {
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 30_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        /* ignore */
      }
      if (Date.now() >= deadline) {
        return () => {};
      }
      await sleep(50);
    }
  }
}

export function loadCachedClientId(platformUrl, redirectUri) {
  const plat = String(platformUrl || "").trim().replace(/\/+$/, "");
  const redir = String(redirectUri || "").trim();
  if (!plat) return "";
  try {
    const raw = fs.readFileSync(oauthClientsPath(), "utf8");
    const map = JSON.parse(raw);
    if (map && typeof map === "object") {
      if (redir && map[`${plat}|${redir}`]) return String(map[`${plat}|${redir}`]).trim();
      if (map[plat]) return String(map[plat]).trim();
    }
  } catch {
    /* ignore */
  }
  const creds = loadCredentials();
  if (
    creds &&
    creds.client_id &&
    String(creds.platform_url || "").trim().replace(/\/+$/, "") === plat
  ) {
    return String(creds.client_id).trim();
  }
  return "";
}

export function saveCachedClientId(platformUrl, redirectUri, clientId) {
  const plat = String(platformUrl || "").trim().replace(/\/+$/, "");
  const redir = String(redirectUri || "").trim();
  const cid = String(clientId || "").trim();
  if (!plat || !cid) return;
  try {
    const dir = biviaConfigDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let map = {};
    try {
      map = JSON.parse(fs.readFileSync(oauthClientsPath(), "utf8")) || {};
    } catch {
      map = {};
    }
    if (redir) map[`${plat}|${redir}`] = cid;
    map[plat] = cid;
    fs.writeFileSync(oauthClientsPath(), JSON.stringify(map, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch {
    /* ignore */
  }
}

export function clearCachedClientId(platformUrl, redirectUri) {
  const plat = String(platformUrl || "").trim().replace(/\/+$/, "");
  const redir = String(redirectUri || "").trim();
  if (!plat) return;
  try {
    const map = JSON.parse(fs.readFileSync(oauthClientsPath(), "utf8")) || {};
    delete map[`${plat}|${redir}`];
    delete map[plat];
    fs.writeFileSync(oauthClientsPath(), JSON.stringify(map, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch {
    /* ignore */
  }
}

export function parseScopeMetadata(scopeStr) {
  const scopes = String(scopeStr || "").trim().split(/\s+/).filter(Boolean);
  let tenantId = null;
  const groupIds = [];
  let permission = null;
  for (const s of scopes) {
    const parts = s.split(":");
    if (parts.length === 3 && ["read", "write", "admin"].includes(parts[2])) {
      if (!tenantId) tenantId = parts[0];
      if (!groupIds.includes(parts[1])) groupIds.push(parts[1]);
      if (
        !permission ||
        parts[2] === "admin" ||
        (parts[2] === "write" && permission === "read")
      ) {
        permission = parts[2];
      }
    }
  }
  return {
    tenantId,
    groupId: groupIds[0] || null,
    groupIds,
    permission,
    scopes,
  };
}

export function platformOrigin(apiBase) {
  if (process.env.BIVIA_PLATFORM_URL) {
    return process.env.BIVIA_PLATFORM_URL.replace(/\/+$/, "");
  }
  const b = String(apiBase || process.env.BIVIA_API_BASE || DEFAULT_BASE)
    .trim()
    .replace(/\/+$/, "");
  try {
    const u = new URL(b);
    if (u.hostname === "api.articul8.ai") return "https://app.articul8.ai";
    if (u.hostname.startsWith("api.")) {
      return `${u.protocol}//app.${u.hostname.slice(4)}`;
    }
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      if (u.port === "8888" || u.port === "8902") {
        return `${u.protocol}//${u.hostname}:3000`;
      }
    }
    return u.origin;
  } catch {
    return "https://app.articul8.ai";
  }
}

export function loadCredentials() {
  try {
    const raw = fs.readFileSync(credentialsPath(), "utf8");
    const creds = JSON.parse(raw);
    if (!creds || typeof creds !== "object") return null;
    if (creds.expires_at) {
      creds.expires_at = normalizeExpiresAt(creds.expires_at);
    }
    return creds;
  } catch {
    return null;
  }
}

export function loadLegacyConfigKey() {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if ((k === "A8_API_KEY" || k === "BIVIA_API_KEY") && v) return v;
    }
  } catch {
    /* ignore */
  }
  return "";
}

export function saveCredentials(creds) {
  if (creds && creds.expires_at) {
    creds.expires_at = normalizeExpiresAt(creds.expires_at);
  }
  const dir = biviaConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + "\n", {
    mode: 0o600,
  });
  // ~/.bivia/config belongs to the `bivia` CLI (its long-lived BIVIA_API_KEY / BIVIA_API_BASE, read by the
  // background Turbo proxy and the guardian). OAuth tokens live only in credentials.json — never write config.
}

// A sign-in: credentials.json holds a token from an OAuth login (it carries a refresh token or a client).
// A key saved with `login --key` (method "api_key", or a bare token from older versions) is not one.
export function hasOAuthSession(creds = loadCredentials()) {
  return Boolean(
    creds &&
      creds.access_token &&
      creds.method !== "api_key" &&
      (creds.refresh_token || creds.client_id)
  );
}

// An API key replaces any sign-in: credentials.json then holds only the key.
export function saveApiKey(key) {
  const k = cleanToken(key);
  if (!k) throw new OAuthError("The API key is empty", "empty_api_key");
  saveCredentials({
    method: "api_key",
    access_token: k,
    api_base: process.env.BIVIA_API_BASE || undefined,
  });
}

export function clearCredentials() {
  try {
    fs.unlinkSync(credentialsPath());
  } catch {
    /* ignore */
  }
  // leave ~/.bivia/config alone: it is the `bivia` CLI's saved API key, not this sign-in
}

let _mcpRefreshing = null;

export async function refreshCredentialsIfNeeded(opts = {}) {
  const initial = loadCredentials();
  if (!initial || !initial.refresh_token || !initial.client_id) {
    return initial;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = normalizeExpiresAt(initial.expires_at);
  const expiresSoon = expSec > 0 ? nowSec + 60 >= expSec : false;
  if (!opts.force && !expiresSoon) {
    return initial;
  }

  if (_mcpRefreshing) return _mcpRefreshing;

  _mcpRefreshing = (async () => {
    const unlock = await acquireCredentialsLock();
    try {
      let creds = loadCredentials() || initial;
      const diskExp = normalizeExpiresAt(creds.expires_at);
      if (
        (initial.access_token &&
          creds.access_token &&
          creds.access_token !== initial.access_token) ||
        (!opts.force && diskExp > 0 && Math.floor(Date.now() / 1000) + 60 < diskExp)
      ) {
        return creds;
      }

      const plat =
        creds.platform_url || platformOrigin(opts.base || creds.api_base);
      const tokenEndpoint =
        creds.token_endpoint || `${plat.replace(/\/+$/, "")}/api/oauth/token`;

      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refresh_token,
        client_id: creds.client_id,
      });

      const fetchImpl = opts.fetch || fetch;
      const res = await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: form.toString(),
      });
      if (!res.ok) {
        throw new OAuthError(
          `OAuth token refresh failed (HTTP ${res.status})`,
          "oauth_refresh_failed"
        );
      }
      const tok = await res.json();
      if (!tok || !tok.access_token) {
        throw new OAuthError(
          "OAuth token refresh returned no access_token",
          "oauth_refresh_failed"
        );
      }

      const updated = {
        ...creds,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token || creds.refresh_token,
        token_type: tok.token_type || creds.token_type || "bearer",
        scope: tok.scope || creds.scope || "",
        expires_at:
          Math.floor(Date.now() / 1000) + (Number(tok.expires_in) || 3600),
      };
      const meta = parseScopeMetadata(updated.scope);
      if (meta.tenantId) updated.tenant_id = meta.tenantId;
      if (meta.groupId) updated.group_id = meta.groupId;
      if (meta.groupIds.length) updated.group_ids = meta.groupIds;
      if (meta.permission) updated.permission = meta.permission;

      saveCredentials(updated);
      return updated;
    } finally {
      unlock();
    }
  })().finally(() => {
    _mcpRefreshing = null;
  });

  return _mcpRefreshing;
}

// The key or token as sent: no "Bearer " prefix, no whitespace.
export function cleanToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/^bearer(\s+|$)/i, "")
    .replace(/\s+/g, "");
}

// Only the last 4 characters of a key are ever shown, as in the browser extension.
export function maskKey(key) {
  const k = cleanToken(key);
  return k ? `••••${k.slice(-4)}` : "";
}

export async function resolveAuthConfig(opts = {}) {
  const envKey = cleanToken(
    (opts && opts.apiKey) ||
      process.env.A8_API_KEY ||
      process.env.BIVIA_API_KEY ||
      ""
  );
  if (envKey) {
    return {
      apiKey: envKey,
      baseURL: opts.base || process.env.BIVIA_API_BASE || undefined,
      source: "env",
    };
  }

  try {
    await refreshCredentialsIfNeeded(opts);
  } catch {
    /* proceed with existing token if refresh fails */
  }

  const creds = loadCredentials();
  if (creds && creds.access_token) {
    return {
      apiKey: cleanToken(creds.access_token),
      baseURL:
        opts.base ||
        process.env.BIVIA_API_BASE ||
        creds.api_base ||
        undefined,
      source: hasOAuthSession(creds) ? "oauth" : "api_key",
    };
  }

  const legacy = cleanToken(loadLegacyConfigKey());
  if (legacy) {
    return {
      apiKey: legacy,
      baseURL: opts.base || process.env.BIVIA_API_BASE || undefined,
      source: "config",
    };
  }

  return {
    apiKey: "",
    baseURL: opts.base || process.env.BIVIA_API_BASE || undefined,
    source: null,
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function base64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// The platform's sign-up page with the Bivia code and source, as in the browser extension. Sign-up
// happens in the browser; the OAuth login runs afterwards, with the new account.
export function signupUrl(platformUrl) {
  let u;
  try {
    u = new URL("/registration", platformUrl || platformOrigin());
  } catch {
    u = null;
  }
  if (!u || !isWebUrl(u)) {
    throw new OAuthError("The platform URL must be an http(s) URL", "invalid_platform_url");
  }
  u.searchParams.set("code", "bivia");
  u.searchParams.set("source", "bivia");
  return u.toString();
}

// A platform URL a tool call may pass (it comes from the model): an Articul8 https host, or the platform the
// user set in BIVIA_PLATFORM_URL. Any other platform is set by the user (env or the CLI's --platform).
export function isAllowedPlatformUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "https:" && (u.hostname === "articul8.ai" || u.hostname.endsWith(".articul8.ai"))) {
    return true;
  }
  try {
    return Boolean(process.env.BIVIA_PLATFORM_URL) && new URL(process.env.BIVIA_PLATFORM_URL).origin === u.origin;
  } catch {
    return false;
  }
}

function isWebUrl(u) {
  return u.protocol === "https:" || u.protocol === "http:";
}

export function openBrowserUrl(url) {
  // Only web pages: a URL built from tool input (platform_url) or from discovery must never reach the OS
  // opener with another scheme (file:, an app's custom scheme, …).
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!isWebUrl(parsed)) return false;
  try {
    const plat = process.platform;
    const cmd =
      plat === "darwin" ? "open" : plat === "win32" ? "rundll32" : "xdg-open";
    const args =
      plat === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // no opener on this machine (e.g. a server without xdg-open): ignore — the link is printed for the user.
    // Without a listener, the spawn error would crash the whole process.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function discoverOAuth(platformUrl, fetchImpl = fetch) {
  const plat = String(platformUrl || "").replace(/\/+$/, "");
  for (const pathSuffix of [
    "/.well-known/oauth-authorization-server",
    "/api/oauth/config",
  ]) {
    try {
      const res = await fetchImpl(`${plat}${pathSuffix}`, {
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const j = await res.json();
        return {
          issuer: j.issuer || j.hydraBrowserUrl || plat,
          authorization_endpoint:
            j.authorization_endpoint ||
            `${(j.hydraBrowserUrl || plat).replace(/\/+$/, "")}/oauth2/auth`,
          token_endpoint:
            j.token_proxy_endpoint ||
            j.token_endpoint ||
            `${plat}/api/oauth/token`,
          registration_endpoint:
            j.registration_endpoint || `${plat}/api/oauth/register`,
        };
      }
    } catch {
      /* try next */
    }
  }
  return {
    issuer: plat,
    authorization_endpoint: `${plat}/oauth2/auth`,
    token_endpoint: `${plat}/api/oauth/token`,
    registration_endpoint: `${plat}/api/oauth/register`,
  };
}

const DEFAULT_LOOPBACK_PORTS = [19284, 19285, 19286, 0];

async function listenLoopback(srv, explicitPort) {
  const candidates =
    explicitPort != null ? [explicitPort] : DEFAULT_LOOPBACK_PORTS;
  let lastErr;
  for (const p of candidates) {
    try {
      await new Promise((res, rej) => {
        const onErr = (err) => {
          srv.removeListener("listening", onListen);
          rej(err);
        };
        const onListen = () => {
          srv.removeListener("error", onErr);
          res();
        };
        srv.once("error", onErr);
        srv.once("listening", onListen);
        srv.listen(p, "127.0.0.1");
      });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new OAuthError("Failed to bind loopback port", "oauth_port_failed");
}

export async function oauthLogin(opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const apiBase =
    opts.base || process.env.BIVIA_API_BASE || DEFAULT_BASE;
  const plat = (opts.platformUrl || platformOrigin(apiBase)).replace(/\/+$/, "");
  const meta = await discoverOAuth(plat, fetchImpl);

  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(
    crypto.createHash("sha256").update(verifier).digest()
  );
  const state = base64Url(crypto.randomBytes(16));

  let resolveCallback;
  let rejectCallback;
  const callbackPromise = new Promise((res, rej) => {
    resolveCallback = res;
    rejectCallback = rej;
  });

  let redirectUri = "";
  const srv = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      // Anything can request this local address while we wait (a web page via <img>), so only a callback
      // carrying OUR state may end the login; others get a page and are otherwise ignored.
      const gotState = reqUrl.searchParams.get("state");
      if (gotState !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font-family:system-ui;background:#09090b;color:#f4f4f5;padding:40px;text-align:center"><h2>Invalid OAuth Callback</h2><p>This link doesn't belong to the sign-in in progress.</p></body></html>`
        );
        return;
      }
      const errParam = reqUrl.searchParams.get("error");
      if (errParam) {
        if (/invalid_client|unauthorized_client/i.test(errParam)) {
          clearCachedClientId(plat, redirectUri);
        }
        const desc = escapeHtml(reqUrl.searchParams.get("error_description") || errParam);
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font-family:system-ui;background:#09090b;color:#f4f4f5;padding:40px;text-align:center"><h2>Authentication Failed</h2><p>${desc}</p></body></html>`
        );
        rejectCallback(new OAuthError(`OAuth error: ${desc}`, "oauth_denied"));
        return;
      }
      const code = reqUrl.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font-family:system-ui;background:#09090b;color:#f4f4f5;padding:40px;text-align:center"><h2>Invalid OAuth Callback</h2><p>State mismatch or missing code.</p></body></html>`
        );
        rejectCallback(
          new OAuthError(
            "OAuth callback is missing the authorization code",
            "oauth_invalid_callback"
          )
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<html><body style="font-family:system-ui;background:#09090b;color:#34d399;padding:40px;text-align:center"><h2>✓ Signed in to Articul8 Bivia</h2><p style="color:#a1a1aa">You can close this tab and return to your terminal or editor.</p></body></html>`
      );
      resolveCallback(code);
    } catch (e) {
      rejectCallback(e);
    }
  });

  await listenLoopback(srv, opts.port);

  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  redirectUri = `http://127.0.0.1:${port}/callback`;

  // 5 minutes, like the Go bivia CLI: a first sign-in or a switch can stop on the consent page for a while
  const timeoutMs = opts.timeoutMs || 300_000;
  const timer = setTimeout(() => {
    rejectCallback(
      new OAuthError("Timed out waiting for browser OAuth login", "oauth_timeout")
    );
  }, timeoutMs);

  try {
    // The platform binds a client to the account that first consents to it, so the cached client is reused
    // only while signed in; after a sign-out, or to switch account, the next login may be a different account.
    let clientId = opts.forceRegister || opts.switchAccount
      ? ""
      : opts.clientId || (hasOAuthSession() ? loadCachedClientId(plat, redirectUri) : "");
    if (!clientId) {
      const redirectUris = Array.from(
        new Set([
          redirectUri,
          "http://127.0.0.1:19284/callback",
          "http://127.0.0.1:19285/callback",
          "http://127.0.0.1:19286/callback",
        ])
      );
      const dcrRes = await fetchImpl(meta.registration_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_name: opts.clientName || "Bivia MCP Server",
          redirect_uris: redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      if (!dcrRes.ok) {
        const txt = await dcrRes.text().catch(() => "");
        throw new OAuthError(
          `Dynamic client registration failed (HTTP ${dcrRes.status}): ${txt}`,
          "oauth_dcr_failed"
        );
      }
      const clientInfo = await dcrRes.json();
      clientId = clientInfo.client_id;
      if (!clientId) {
        throw new OAuthError(
          "Dynamic client registration did not return client_id",
          "oauth_dcr_failed"
        );
      }
      saveCachedClientId(plat, redirectUri, clientId);
    }

    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set(
      "scope",
      opts.scope || "openid offline_access"
    );
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    // Standard OIDC hint. The platform ignores it today and reuses the browser's Articul8 session, so a switch
    // changes organization and group only (see SWITCH_ACCOUNT_NOTE).
    if (opts.switchAccount) authUrl.searchParams.set("prompt", "login");

    const authorizeUrlStr = authUrl.toString();
    if (typeof opts.onAuthUrl === "function") {
      opts.onAuthUrl(authorizeUrlStr);
    }
    if (opts.openBrowser !== false) {
      openBrowserUrl(authorizeUrlStr);
    }

    const code = await callbackPromise;

    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    const tokRes = await fetchImpl(meta.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: tokenForm.toString(),
    });
    if (!tokRes.ok) {
      const txt = await tokRes.text().catch(() => "");
      if (/invalid_client/i.test(txt)) {
        clearCachedClientId(plat, redirectUri);
      }
      throw new OAuthError(
        `OAuth token exchange failed (HTTP ${tokRes.status}): ${txt}`,
        "oauth_token_failed"
      );
    }
    const tok = await tokRes.json();
    if (!tok || !tok.access_token) {
      throw new OAuthError(
        "OAuth token exchange returned no access_token",
        "oauth_token_failed"
      );
    }

    saveCachedClientId(plat, redirectUri, clientId);
    const scopeMeta = parseScopeMetadata(tok.scope || "");
    const creds = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || "",
      token_type: tok.token_type || "bearer",
      expires_at:
        Math.floor(Date.now() / 1000) + (Number(tok.expires_in) || 3600),
      scope: tok.scope || "",
      client_id: clientId,
      redirect_uri: redirectUri,
      tenant_id: scopeMeta.tenantId || "",
      group_id: scopeMeta.groupId || "",
      group_ids: scopeMeta.groupIds || [],
      permission: scopeMeta.permission || "",
      platform_url: plat,
      token_endpoint: meta.token_endpoint,
      api_base: process.env.BIVIA_API_BASE || undefined,
    };
    saveCredentials(creds);
    return creds;
  } finally {
    clearTimeout(timer);
    try {
      srv.close();
    } catch {
      /* ignore */
    }
  }
}

// The platform signs in whichever account the browser already has a session for, even with prompt=login.
export const SWITCH_ACCOUNT_NOTE =
  "To use a different account, sign out of Articul8 in your browser first, then switch again.";

// As the browser extension shows them: ids over 16 characters become "first8…last5".
export function shortId(id) {
  const s = String(id || "");
  return s.length > 16 ? s.slice(0, 8) + "…" + s.slice(-5) : s;
}

// The host the Bivia calls go to (the same base resolveAuthConfig picks).
function endpointHost(base) {
  const b = process.env.BIVIA_API_BASE || base || DEFAULT_BASE;
  try {
    return new URL(b).host;
  } catch {
    return b;
  }
}

export function getAuthStatus() {
  const envKey = cleanToken(
    process.env.A8_API_KEY || process.env.BIVIA_API_KEY || ""
  );
  const creds = loadCredentials();
  const legacyKey = cleanToken(loadLegacyConfigKey());
  if (envKey) {
    // resolveAuthConfig uses an env key before any sign-in, so say so
    return {
      authenticated: true,
      method: "env_api_key",
      token_type: /^ory_at_/.test(envKey) ? "ory_access_token" : "api_key",
      key_hint: maskKey(envKey),
      endpoint: endpointHost(),
      oauth_signed_in_but_unused: hasOAuthSession(creds),
    };
  }
  if (creds && creds.access_token && !hasOAuthSession(creds)) {
    return {
      authenticated: true,
      method: "api_key",
      token_type: /^ory_at_/.test(creds.access_token) ? "ory_access_token" : "api_key",
      key_hint: maskKey(creds.access_token),
      endpoint: endpointHost(creds.api_base),
    };
  }
  if (creds && creds.access_token) {
    const scopeMeta = parseScopeMetadata(creds.scope || "");
    const groupId = creds.group_id || scopeMeta.groupId || null;
    return {
      authenticated: true,
      method: "oauth",
      tenant_id: creds.tenant_id || scopeMeta.tenantId || null,
      group_id: groupId,
      group_short: groupId ? shortId(groupId) : null,
      group_ids:
        creds.group_ids && creds.group_ids.length
          ? creds.group_ids
          : scopeMeta.groupIds,
      permission: creds.permission || scopeMeta.permission || null,
      scope: creds.scope || "",
      expires_at: creds.expires_at || null,
      platform_url: creds.platform_url || null,
      endpoint: endpointHost(creds.api_base),
      has_refresh_token: Boolean(creds.refresh_token),
    };
  }
  if (legacyKey) {
    return {
      authenticated: true,
      method: "config_api_key",
      token_type: /^ory_at_/.test(legacyKey) ? "ory_access_token" : "api_key",
      key_hint: maskKey(legacyKey),
      endpoint: endpointHost(),
    };
  }
  return { authenticated: false, method: null };
}

// One readable line per state, like the extension popup's connected card.
export function describeAuthStatus(st) {
  const at = st.endpoint ? `. Endpoint: ${st.endpoint}` : "";
  switch (st.method) {
    case "oauth":
      return `Signed in with Articul8 — tenant ${st.tenant_id || "unknown"}, group ${st.group_short || "unknown"}, permission ${st.permission || "unknown"}${at}`;
    case "api_key":
      return `Connected with API key ${st.key_hint} (saved with login --key)${at}`;
    case "env_api_key":
      return `Connected with API key ${st.key_hint} from the environment${at}${st.oauth_signed_in_but_unused ? ". An Articul8 sign-in is saved but unused while the environment key is set" : ""}`;
    case "config_api_key":
      return `Connected with the bivia CLI's API key ${st.key_hint} (~/.bivia/config)${at}`;
    default:
      return "Not authenticated — call bivia_login (or bivia_signup to create a free account), run `npx @articul8/bivia-mcp login`, or set A8_API_KEY";
  }
}
