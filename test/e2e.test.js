// End to end: the real server.js (CLI `login` / `logout` and the stdio MCP server) against a fake Articul8
// platform (discovery, DCR, authorize, token — PKCE S256 checked, refresh tokens rotated like Ory) and a fake
// Bivia API. Everything lives in a throwaway BIVIA_CONFIG_DIR; no real browser is opened (no opener on PATH).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(SERVER), "package.json"), "utf8")).version;
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const readBody = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => { d += c; }); req.on("end", () => r(d)); });
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));

// ---- fake Articul8 platform ---------------------------------------------------------------------------
function fakePlatform() {
  const st = { clients: 0, codes: new Map(), live: new Set(), refresh: new Map(), refreshCalls: 0, failRefresh: false, expiresIn: 3600 };
  let origin = "";
  const issue = () => {
    const access = "ory_at_" + crypto.randomBytes(8).toString("hex"), rt = "ory_rt_" + crypto.randomBytes(8).toString("hex");
    st.live.add(access); st.refresh.set(rt, true);
    return { access_token: access, refresh_token: rt, token_type: "bearer", expires_in: st.expiresIn, scope: "openid offline_access acme:eng:write" };
  };
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, origin);
    const json = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/.well-known/oauth-authorization-server")
      return json(200, { issuer: origin, authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", registration_endpoint: origin + "/register" });
    if (u.pathname === "/register") { st.clients++; const b = JSON.parse(await readBody(req)); st.redirects = b.redirect_uris; return json(201, { client_id: "client-" + st.clients, redirect_uris: b.redirect_uris }); }
    if (u.pathname === "/authorize") {                      // the "browser" lands here: consent granted at once
      st.lastAuthorize = u.searchParams;
      const code = crypto.randomBytes(6).toString("hex");
      st.codes.set(code, { challenge: u.searchParams.get("code_challenge"), redirect: u.searchParams.get("redirect_uri"), client: u.searchParams.get("client_id") });
      res.writeHead(302, { location: `${u.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(u.searchParams.get("state"))}` });
      return res.end();
    }
    if (u.pathname === "/token") {
      const f = new URLSearchParams(await readBody(req));
      if (f.get("grant_type") === "authorization_code") {
        const c = st.codes.get(f.get("code")); st.codes.delete(f.get("code"));
        const ok = c && c.redirect === f.get("redirect_uri") && c.client === f.get("client_id")
          && b64url(crypto.createHash("sha256").update(f.get("code_verifier") || "").digest()) === c.challenge;   // PKCE S256
        return ok ? json(200, issue()) : json(400, { error: "invalid_grant" });
      }
      if (f.get("grant_type") === "refresh_token") {
        st.refreshCalls++;
        if (st.failRefresh || !st.refresh.get(f.get("refresh_token"))) return json(400, { error: "invalid_grant" });
        st.refresh.delete(f.get("refresh_token"));         // rotation: an old refresh token never works twice
        return json(200, issue());
      }
    }
    json(404, { error: "not_found" });
  });
  return { st, srv, start: async () => (origin = await listen(srv)) };
}

// ---- fake Bivia API: records what arrived, 401 for tokens the platform doesn't consider live ------------
function fakeApi(platformState) {
  const seen = [], rejected = new Set();
  const srv = http.createServer(async (req, res) => {
    await readBody(req);
    const auth = req.headers.authorization || "", app = req.headers["x-a8-client-app"] || "";
    seen.push({ path: req.url, auth, app });
    const tok = auth.replace(/^Bearer\s+/i, "");
    if (!tok || rejected.has(tok) || (tok.startsWith("ory_at_") && !platformState.live.has(tok))) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"message":"Authentication required"}'); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "boolean", value: "yes", probability: 0.97, distribution: { yes: 0.97, no: 0.03 }, status: "answered" }));
  });
  return { seen, rejected, srv, start: () => listen(srv) };
}

const run = (args, env, onStderr) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SERVER, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { err += d; if (onStderr) onStderr(err); });
  const t = setTimeout(() => p.kill(), 30000);
  p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
});

// a stdio MCP session: initialize as `clientName`, then call tools
const children = new Set();
async function mcpSession(env, clientName) {
  const p = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  children.add(p); p.on("close", () => children.delete(p));
  let buf = "", id = 0;
  const pending = new Map();
  p.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} }
  });
  const call = (method, params) => new Promise((r, j) => {
    const n = ++id; const t = setTimeout(() => j(new Error(`MCP ${method} timed out`)), 20000);
    pending.set(n, (m) => { clearTimeout(t); r(m); }); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: clientName, version: "1.0" } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await new Promise((r) => setTimeout(r, 100));
  return { tool: (name, args) => call("tools/call", { name, arguments: args }), close: () => p.kill() };
}

test("login → MCP calls → refresh → expired sign-in → logout, end to end", async () => {
  const plat = fakePlatform(), platformUrl = await plat.start();
  const api = fakeApi(plat.st), apiBase = await api.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bivia-mcp-e2e-"));
  // the `bivia` CLI's own config: a long-lived key + base, read by its background proxy — must survive everything
  const CLI_CONFIG = "BIVIA_API_KEY=cli-long-lived-key\nBIVIA_API_BASE=https://api.articul8.ai/bivia\n";
  fs.writeFileSync(path.join(dir, "config"), CLI_CONFIG, { mode: 0o600 });
  const env = { PATH: path.dirname(process.execPath), HOME: dir, BIVIA_CONFIG_DIR: dir, BIVIA_PLATFORM_URL: platformUrl, BIVIA_API_BASE: apiBase };
  const config = () => fs.readFileSync(path.join(dir, "config"), "utf8");
  const creds = () => JSON.parse(fs.readFileSync(path.join(dir, "credentials.json"), "utf8"));

  try {
    // 1) CLI login. Play the browser — but first, a hostile page hits the loopback while the login waits.
    let attacked = false, attackPage = "";
    const login = run(["login"], env, async (stderr) => {
      const m = stderr.match(/visit:\s*\n\s*(\S+)/);
      if (!m || attacked) return;
      attacked = true;
      const authUrl = new URL(m[1]), redirect = authUrl.searchParams.get("redirect_uri");
      attackPage = await (await fetch(`${redirect}?error=access_denied&error_description=${encodeURIComponent("<script>alert(1)</script>")}`)).text();
      await fetch(`${redirect}?code=stolen&state=wrong`);
      const r = await fetch(m[1], { redirect: "follow" });                     // the real sign-in
      assert.match(await r.text(), /Signed in/);
    });
    const done = await login;
    assert.equal(done.code, 0, done.err);
    assert.match(done.err, /Signed in to Articul8 \(tenant: acme, group: eng/);
    assert.ok(!/<script>/.test(attackPage), "attacker text must not be reflected unescaped");
    const c1 = creds();
    assert.ok(c1.access_token.startsWith("ory_at_") && c1.refresh_token && c1.client_id === "client-1");
    assert.ok(c1.expires_at > 1e9 && c1.expires_at < 1e11, "expires_at in seconds");
    assert.equal(config(), CLI_CONFIG, "login must not touch the bivia CLI's config");
    for (const p of [19284, 19285, 19286]) assert.ok(plat.st.redirects.includes(`http://127.0.0.1:${p}/callback`), "all fixed loopback ports registered");

    // 2) the MCP server uses the sign-in, names the editor, and the version
    const s = await mcpSession(env, "claude-code");
    let r = await s.tool("bivia_boolean", { question: "Is the sky blue?" });
    assert.equal(r.result.isError, undefined, JSON.stringify(r));
    let last = api.seen.at(-1);
    assert.equal(last.auth, `Bearer ${c1.access_token}`);
    assert.equal(last.app, `mcp:claude-code/${PKG_VERSION}`);
    const st = await s.tool("bivia_auth_status", {});
    assert.match(st.result.content[0].text, /Signed in with Articul8 — tenant acme, group eng, permission write\. Endpoint: 127\.0\.0\.1:\d+/);

    // 3) the platform drops the access token → 401 → one refresh (rotated) → the call succeeds
    plat.st.live.delete(c1.access_token);
    r = await s.tool("bivia_boolean", { question: "Is the sky blue?" });
    assert.equal(r.result.isError, undefined, JSON.stringify(r));
    const c2 = creds();
    assert.notEqual(c2.access_token, c1.access_token);
    assert.notEqual(c2.refresh_token, c1.refresh_token, "refresh token rotated");
    assert.equal(api.seen.at(-1).auth, `Bearer ${c2.access_token}`);
    assert.equal(plat.st.refreshCalls, 1);
    assert.equal(config(), CLI_CONFIG, "refresh must not touch the bivia CLI's config");

    // 4) the sign-in can't be renewed any more → a clear "sign in again"
    plat.st.live.delete(c2.access_token); plat.st.failRefresh = true;
    r = await s.tool("bivia_boolean", { question: "Is the sky blue?" });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /sign-in has expired.*bivia_login/s);
    s.close();

    // 5) another editor is named as such
    plat.st.failRefresh = false;
    let started = false;
    const again = await run(["login"], env, async (stderr) => { const m = stderr.match(/visit:\s*\n\s*(\S+)/); if (m && !started) { started = true; await fetch(m[1]); } });
    assert.equal(again.code, 0, again.err);
    assert.equal(plat.st.clients, 1, "the registered client is reused on the next login");
    const s2 = await mcpSession(env, "cursor-vscode");
    await s2.tool("bivia_boolean", { question: "Is the sky blue?" });
    assert.equal(api.seen.at(-1).app, `mcp:cursor/${PKG_VERSION}`);

    // 5b) switching account: a fresh client, prompt=login, and a note on how to pick another account
    assert.equal(plat.st.lastAuthorize.get("prompt"), null, "a plain login does not force a new login");
    let switched = false;
    const sw = await run(["login", "--switch"], env, async (stderr) => { const m = stderr.match(/visit:\s*\n\s*(\S+)/); if (m && !switched) { switched = true; await fetch(m[1]); } });
    assert.equal(sw.code, 0, sw.err);
    assert.equal(plat.st.clients, 2, "switch registers a fresh client");
    assert.equal(plat.st.lastAuthorize.get("prompt"), "login");
    assert.match(sw.err, /sign out of Articul8 in your browser/);
    const busy = await run(["signup"], env);
    assert.equal(busy.code, 1, "no sign-up while signed in");
    assert.match(busy.err, /Already signed in.*login --switch/s);
    s2.close();

    // 5c) a key replaces a sign-in only once one test call accepts it
    api.rejected.add("k-typo-0001");
    let k = await run(["login", "--key", "k-typo-0001"], env);
    assert.equal(k.code, 1, "a rejected key is refused while signed in");
    assert.match(k.err, /rejected this key.*Nothing changed.*--force/s);
    assert.ok(creds().refresh_token, "the sign-in is kept");
    k = await run(["login", "--key", "k-good-0002"], { ...env, BIVIA_API_BASE: "http://127.0.0.1:9" });   // cannot be checked
    assert.equal(k.code, 1);
    assert.match(k.err, /Could not check this key.*Nothing changed/s);
    assert.ok(creds().refresh_token, "the sign-in is still kept");
    k = await run(["login", "--key", "k-good-0003"], env);
    assert.equal(k.code, 0, k.err);
    assert.match(k.err, /replaces the Articul8 sign-in \(tenant acme\)/);
    assert.equal(creds().method, "api_key");
    assert.equal(config(), CLI_CONFIG, "login --key must not touch the bivia CLI's config");

    // 6) logout clears the sign-in only
    const out = await run(["logout"], env);
    assert.equal(out.code, 0);
    assert.ok(!fs.existsSync(path.join(dir, "credentials.json")));
    assert.equal(config(), CLI_CONFIG, "logout must not delete the bivia CLI's config");

    // 7) with no sign-in, the CLI's saved key is used (read-only)
    const s3 = await mcpSession(env, "codex-mcp-client");
    r = await s3.tool("bivia_boolean", { question: "Is the sky blue?" });
    last = api.seen.at(-1);
    assert.equal(last.auth, "Bearer cli-long-lived-key");
    assert.equal(last.app, `mcp:codex/${PKG_VERSION}`);
    s3.close();

    // 8) `login --key` with nothing to replace saves the key without a test call, and it is reported as a key
    const key = await run(["login", "--key", "k-test-1234"], env);
    assert.equal(key.code, 0, key.err);
    assert.match(key.err, /Saved API key/);
    assert.equal(creds().method, "api_key");
    assert.equal(creds().refresh_token, undefined);
    const blank = await run(["login", "--key", "  "], env);
    assert.equal(blank.code, 1, "an empty key is refused");
    assert.match(blank.err, /^Error: The API key is empty/m);
    assert.ok(!/at .*oauth\.js/.test(blank.err), "one line, no stack trace");
    assert.equal(creds().access_token, "k-test-1234", "the saved key is kept");
    for (const args of [["login", "--key", ""], ["login", "--key"]]) {   // an empty or missing value never starts a browser login
      const none = await run(args, env);
      assert.equal(none.code, 1, JSON.stringify(args));
      assert.match(none.err, /^Error: The API key is empty/m, JSON.stringify(args));
      assert.ok(!/Opening browser/.test(none.err), JSON.stringify(args));
    }
    assert.equal(creds().access_token, "k-test-1234", "the saved key is still kept");
    const keyStatus = JSON.parse((await run(["status"], env)).out);
    assert.equal(keyStatus.method, "api_key");
    assert.equal(keyStatus.key_hint, "••••1234");
    assert.equal(keyStatus.endpoint, new URL(apiBase).host);
    const s4 = await mcpSession(env, "claude-code");
    r = await s4.tool("bivia_boolean", { question: "Is the sky blue?" });
    assert.equal(r.result.isError, undefined, JSON.stringify(r));
    assert.equal(api.seen.at(-1).auth, "Bearer k-test-1234");

    // 8b) Test, as in the extension popup: one real call with the active credential
    let tested = await run(["status", "--test"], env);
    assert.equal(tested.code, 0, tested.err);
    assert.equal(JSON.parse(tested.out).test, "ok");
    assert.equal(api.seen.at(-1).path, "/boolean");
    r = await s4.tool("bivia_auth_status", { test: true });
    assert.match(r.result.content[0].text, /Test: OK/);

    // 9) a rejected key is called a rejected key (masked), never an expired sign-in
    api.rejected.add("k-test-1234");
    r = await s4.tool("bivia_boolean", { question: "Is the sky blue?" });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /api_key_rejected.*rejected the API key ••••1234.*login --key/s);
    assert.ok(!/sign-in has expired|k-test-1234/.test(r.result.content[0].text), r.result.content[0].text);
    const envKeyed = await mcpSession({ ...env, A8_API_KEY: "k-env-9999" }, "claude-code");
    api.rejected.add("k-env-9999");
    const envErr = await envKeyed.tool("bivia_boolean", { question: "Is the sky blue?" });
    assert.match(envErr.result.content[0].text, /••••9999 \(from the A8_API_KEY.*Fix or unset A8_API_KEY/s, "an env key is fixed in the env");
    envKeyed.close();
    r = await s4.tool("bivia_auth_status", { test: true });
    assert.equal(r.result.isError, undefined, "a failed test is a status, not a tool error");
    assert.match(r.result.content[0].text, /Test: the API key was rejected/);
    s4.close();
    tested = await run(["status", "--test"], env);
    assert.equal(tested.code, 1, "a failed test exits 1");
    assert.equal(JSON.parse(tested.out).test, "key_rejected");
    tested = await run(["status", "--test"], { ...env, BIVIA_API_BASE: "http://127.0.0.1:9" });   // nothing listens there
    assert.equal(tested.code, 1);
    assert.deepEqual([JSON.parse(tested.out).test, JSON.parse(tested.out).test_error], ["failed", "network_error"]);
    // a saved key is replaced by --force without the test call
    api.rejected.add("k-forced-7777");
    const seenBefore = api.seen.length;
    const forced = await run(["login", "--key", "k-forced-7777", "--force"], env);
    assert.equal(forced.code, 0, forced.err);
    assert.equal(creds().access_token, "k-forced-7777");
    assert.equal(api.seen.length, seenBefore, "--force makes no test call");

    // 10) sign up: open the platform's sign-up page with the Bivia code and source, then sign in as usual
    const signupPage = `${platformUrl}/registration?code=bivia&source=bivia`;
    const su = await run(["signup"], env);                   // no terminal: print the page and the next step
    assert.equal(su.code, 0, su.err);
    assert.ok(su.err.includes(signupPage), su.err);
    assert.match(su.err, /npx @articul8\/bivia-mcp login/);
    const s5 = await mcpSession(env, "claude-code");
    for (const tool of ["bivia_signup", "bivia_login"]) {             // platform_url comes from the model
      const evil = await s5.tool(tool, { platform_url: "https://evil.example" });
      assert.equal(evil.result.isError, true, tool);
      assert.match(evil.result.content[0].text, /invalid_platform_url.*BIVIA_PLATFORM_URL/s, tool);
    }
    assert.equal(plat.st.clients, 2, "no client registered for a refused platform_url");
    r = await s5.tool("bivia_signup", { platform_url: platformUrl });   // the platform set in the environment is fine
    assert.equal(r.result.isError, undefined, JSON.stringify(r));
    r = await s5.tool("bivia_signup", {});
    assert.equal(r.result.isError, undefined, JSON.stringify(r));
    assert.ok(r.result.content[0].text.includes(signupPage));
    assert.match(r.result.content[0].text, /bivia_login/);
    s5.close();
    assert.equal(config(), CLI_CONFIG, "login --key must not touch the bivia CLI's config");
  } finally {
    for (const c of children) c.kill();
    plat.srv.close(); api.srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
