import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseScopeMetadata,
  normalizeExpiresAt,
  saveCredentials,
  loadCredentials,
  clearCredentials,
  saveApiKey,
  hasOAuthSession,
  shortId,
  describeAuthStatus,
  signupUrl,
  openBrowserUrl,
  isAllowedPlatformUrl,
  getAuthStatus,
  oauthLogin,
  refreshCredentialsIfNeeded,
  resolveAuthConfig,
} from "../oauth.js";

test("parseScopeMetadata extracts tenant, group_ids, and highest permission", () => {
  const meta = parseScopeMetadata(
    "openid offline_access acme:eng:read acme:platform:write"
  );
  assert.equal(meta.tenantId, "acme");
  assert.equal(meta.groupId, "eng");
  assert.deepEqual(meta.groupIds, ["eng", "platform"]);
  assert.equal(meta.permission, "write");
});

test("shortId keeps long ids readable, as the browser extension does", () => {
  assert.equal(shortId("utgnvnamhclxeendqijqnsrlrc"), "utgnvnam…srlrc");
  assert.equal(shortId("eng"), "eng");
  assert.equal(shortId(""), "");
});

test("signupUrl opens the platform's sign-up page with the Bivia code and source", () => {
  assert.equal(
    signupUrl("https://app.example.com/"),
    "https://app.example.com/registration?code=bivia&source=bivia"
  );
});

test("openBrowserUrl opens only http(s) pages", () => {
  // a platform_url from a tool call must not reach the OS opener as file:, javascript: or an app scheme
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "vscode://x", "not a url"]) {
    assert.equal(openBrowserUrl(bad), false, bad);
  }
  assert.throws(() => signupUrl("file:///tmp"), /http/);
  assert.throws(() => signupUrl("nonsense"), (e) => e.code === "invalid_platform_url");
});

test("isAllowedPlatformUrl accepts Articul8 hosts and BIVIA_PLATFORM_URL only", () => {
  const prev = process.env.BIVIA_PLATFORM_URL;
  try {
    delete process.env.BIVIA_PLATFORM_URL;
    for (const ok of ["https://app.articul8.ai", "https://app.dev.articul8.ai/", "https://articul8.ai"]) {
      assert.equal(isAllowedPlatformUrl(ok), true, ok);
    }
    for (const bad of ["https://evil.example", "https://articul8.ai.evil.example", "http://app.articul8.ai", "https://evilarticul8.ai", "nonsense"]) {
      assert.equal(isAllowedPlatformUrl(bad), false, bad);
    }
    process.env.BIVIA_PLATFORM_URL = "http://localhost:3000";
    assert.equal(isAllowedPlatformUrl("http://localhost:3000/"), true, "the platform set in the environment");
    assert.equal(isAllowedPlatformUrl("http://localhost:4000"), false);
  } finally {
    if (prev === undefined) delete process.env.BIVIA_PLATFORM_URL;
    else process.env.BIVIA_PLATFORM_URL = prev;
  }
});

test("saveCredentials / loadCredentials / getAuthStatus / clearCredentials", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivia-mcp-oauth-test-"));
  const prevDir = process.env.BIVIA_CONFIG_DIR;
  const prevA8Key = process.env.A8_API_KEY;
  const prevBiviaKey = process.env.BIVIA_API_KEY;
  process.env.BIVIA_CONFIG_DIR = tmpDir;
  delete process.env.A8_API_KEY;
  delete process.env.BIVIA_API_KEY;

  try {
    assert.equal(getAuthStatus().authenticated, false);
    assert.match(describeAuthStatus(getAuthStatus()), /bivia_login.*bivia_signup/);

    saveCredentials({
      access_token: "ory_at_test_token_1234567890",
      refresh_token: "ory_rt_test_refresh_1234567890",
      scope: "openid offline_access acme:default:admin",
      tenant_id: "acme",
      group_id: "default",
      group_ids: ["default"],
      permission: "admin",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    const loaded = loadCredentials();
    assert.equal(loaded.access_token, "ory_at_test_token_1234567890");
    assert.equal(loaded.tenant_id, "acme");

    const status = getAuthStatus();
    assert.equal(status.authenticated, true);
    assert.equal(status.method, "oauth");
    assert.equal(status.tenant_id, "acme");
    assert.equal(status.group_id, "default");
    assert.equal(status.permission, "admin");
    assert.equal(status.has_refresh_token, true);
    assert.equal(status.endpoint, "api.articul8.ai");
    assert.equal(
      describeAuthStatus(status),
      "Signed in with Articul8 — tenant acme, group default, permission admin. Endpoint: api.articul8.ai"
    );

    // A saved API key replaces the sign-in and is reported as a key, not as OAuth.
    saveApiKey("  k-test-1234  ");
    const keyCreds = loadCredentials();
    assert.equal(keyCreds.method, "api_key");
    assert.equal(keyCreds.access_token, "k-test-1234");
    assert.equal(keyCreds.refresh_token, undefined, "the sign-in is gone");
    assert.equal(hasOAuthSession(), false);
    assert.equal(getAuthStatus().method, "api_key");
    assert.equal(getAuthStatus().tenant_id, undefined);
    assert.equal(getAuthStatus().key_hint, "••••1234");
    assert.equal(
      describeAuthStatus(getAuthStatus()),
      "Connected with API key ••••1234 (saved with login --key). Endpoint: api.articul8.ai"
    );
    process.env.BIVIA_API_KEY = "k-env-0000";
    assert.equal(getAuthStatus().oauth_signed_in_but_unused, false, "a saved key is not a sign-in");
    assert.equal(getAuthStatus().key_hint, "••••0000");
    delete process.env.BIVIA_API_KEY;

    // an empty key (after trimming and a "Bearer" prefix) is refused and keeps what was saved
    for (const empty of ["   ", "Bearer ", "bearer"]) {
      assert.throws(() => saveApiKey(empty), (e) => e.code === "empty_api_key", JSON.stringify(empty));
    }
    assert.equal(loadCredentials().access_token, "k-test-1234");

    // the file older `login --key` versions wrote (a bare token) is a key too
    saveCredentials({ access_token: "k-legacy-5678" });
    assert.equal(hasOAuthSession(), false);
    assert.equal(getAuthStatus().method, "api_key");

    clearCredentials();
    assert.equal(loadCredentials(), null);
    assert.equal(getAuthStatus().authenticated, false);
  } finally {
    if (prevDir === undefined) delete process.env.BIVIA_CONFIG_DIR;
    else process.env.BIVIA_CONFIG_DIR = prevDir;
    if (prevA8Key !== undefined) process.env.A8_API_KEY = prevA8Key;
    if (prevBiviaKey !== undefined) process.env.BIVIA_API_KEY = prevBiviaKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("oauthLogin performs DCR + PKCE loopback exchange and refreshCredentialsIfNeeded rotates expired token", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bivia-mcp-pkce-test-"));
  const prevDir = process.env.BIVIA_CONFIG_DIR;
  const prevA8Key = process.env.A8_API_KEY;
  process.env.BIVIA_CONFIG_DIR = tmpDir;
  delete process.env.A8_API_KEY;

  try {
    let registeredRedirectUri = "";
    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/.well-known/oauth-authorization-server")) {
        return new Response(
          JSON.stringify({
            issuer: "https://auth.example.com",
            authorization_endpoint: "https://auth.example.com/oauth2/auth",
            token_proxy_endpoint: "https://app.example.com/api/oauth/token",
            registration_endpoint: "https://app.example.com/api/oauth/register",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (u.endsWith("/api/oauth/register")) {
        const body = JSON.parse(init.body);
        registeredRedirectUri = body.redirect_uris[0];
        return new Response(
          JSON.stringify({
            client_id: "dyn-client-123",
            redirect_uris: body.redirect_uris,
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }
      if (u.endsWith("/api/oauth/token")) {
        const params = new URLSearchParams(init.body);
        const grantType = params.get("grant_type");
        if (grantType === "authorization_code") {
          assert.equal(params.get("client_id"), "dyn-client-123");
          assert.ok(params.get("code_verifier"));
          return new Response(
            JSON.stringify({
              access_token: "ory_at_initial_token_1234567890",
              refresh_token: "ory_rt_initial_refresh_1234567890",
              token_type: "bearer",
              expires_in: 10, // expires within 60s buffer so next call refreshes
              scope: "openid offline_access acme:core:write",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (grantType === "refresh_token") {
          assert.equal(
            params.get("refresh_token"),
            "ory_rt_initial_refresh_1234567890"
          );
          return new Response(
            JSON.stringify({
              access_token: "ory_at_refreshed_token_9876543210",
              refresh_token: "ory_rt_rotated_refresh_9876543210",
              token_type: "bearer",
              expires_in: 3600,
              scope: "openid offline_access acme:core:write",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }
      throw new Error(`Unexpected fetch URL: ${u}`);
    };

    const creds = await oauthLogin({
      platformUrl: "https://app.example.com",
      openBrowser: false,
      fetch: mockFetch,
      onAuthUrl: (authUrlStr) => {
        const authUrl = new URL(authUrlStr);
        const state = authUrl.searchParams.get("state");
        const redirectUri = authUrl.searchParams.get("redirect_uri");
        assert.equal(redirectUri, registeredRedirectUri);
        const cb = new URL(redirectUri);
        cb.searchParams.set("code", "auth-code-xyz");
        cb.searchParams.set("state", state);
        fetch(cb.toString()).catch(() => {});
      },
    });

    assert.equal(creds.access_token, "ory_at_initial_token_1234567890");
    assert.equal(creds.tenant_id, "acme");
    assert.equal(creds.group_id, "core");
    assert.equal(creds.permission, "write");

    const authCfg = await resolveAuthConfig({ fetch: mockFetch });
    assert.equal(authCfg.apiKey, "ory_at_refreshed_token_9876543210");
    assert.equal(authCfg.source, "oauth");

    const refreshed = await refreshCredentialsIfNeeded({ fetch: mockFetch });
    assert.equal(refreshed.access_token, "ory_at_refreshed_token_9876543210");

    // Second login to same platform + loopback port should reuse cached client_id without calling /api/oauth/register again
    let registerCalls = 0;
    const secondFetch = async (url, init = {}) => {
      if (String(url).endsWith("/api/oauth/register")) registerCalls++;
      return mockFetch(url, init);
    };
    const creds2 = await oauthLogin({
      platformUrl: "https://app.example.com",
      openBrowser: false,
      fetch: secondFetch,
      onAuthUrl: (authUrlStr) => {
        const authUrl = new URL(authUrlStr);
        const cb = new URL(authUrl.searchParams.get("redirect_uri"));
        cb.searchParams.set("code", "auth-code-2");
        cb.searchParams.set("state", authUrl.searchParams.get("state"));
        fetch(cb.toString()).catch(() => {});
      },
    });
    assert.equal(registerCalls, 0);
    assert.equal(creds2.client_id, "dyn-client-123");

    // A client is bound to the account that first consented: once signed out, the next login registers a
    // fresh client, so a different account can sign in.
    clearCredentials();
    const creds3 = await oauthLogin({
      platformUrl: "https://app.example.com",
      openBrowser: false,
      fetch: secondFetch,
      onAuthUrl: (authUrlStr) => {
        const authUrl = new URL(authUrlStr);
        const cb = new URL(authUrl.searchParams.get("redirect_uri"));
        cb.searchParams.set("code", "auth-code-3");
        cb.searchParams.set("state", authUrl.searchParams.get("state"));
        fetch(cb.toString()).catch(() => {});
      },
    });
    assert.equal(registerCalls, 1, "signed out: the cached client is not reused");
    assert.equal(creds3.client_id, "dyn-client-123");

    // Switching account registers a fresh client even while signed in, and asks the platform to log in again.
    let switchUrl = null;
    await oauthLogin({
      platformUrl: "https://app.example.com",
      openBrowser: false,
      fetch: secondFetch,
      switchAccount: true,
      onAuthUrl: (authUrlStr) => {
        switchUrl = new URL(authUrlStr);
        const cb = new URL(switchUrl.searchParams.get("redirect_uri"));
        cb.searchParams.set("code", "auth-code-4");
        cb.searchParams.set("state", switchUrl.searchParams.get("state"));
        fetch(cb.toString()).catch(() => {});
      },
    });
    assert.equal(registerCalls, 2, "switch: always a fresh client");
    assert.equal(switchUrl.searchParams.get("prompt"), "login");

    // Millisecond normalization (> 1e12 -> seconds)
    const msVal = Date.now() + 600_000;
    const normSec = normalizeExpiresAt(msVal);
    assert.ok(normSec < 1e12 && normSec > Math.floor(Date.now() / 1000));
  } finally {
    if (prevDir === undefined) delete process.env.BIVIA_CONFIG_DIR;
    else process.env.BIVIA_CONFIG_DIR = prevDir;
    if (prevA8Key !== undefined) process.env.A8_API_KEY = prevA8Key;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

