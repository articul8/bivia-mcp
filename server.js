#!/usr/bin/env node
// @articul8/bivia-mcp — Model Context Protocol server exposing the Bivia
// decision API as tools. Works in any MCP host (Claude Code, Codex,
// VS Code, …) over stdio via `npx -y @articul8/bivia-mcp`.
//
// 8 tools: bivia_boolean, bivia_choice, bivia_score, bivia_set, bivia_span,
//          bivia_decide, bivia_ground, bivia_ds.
//
// Tools are always listable (no API key required to list). A missing
// A8_API_KEY only fails at call time with a clear, actionable message.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import Bivia, { APIError, APIConnectionError } from "@articul8/bivia";

import { formatAnswer, formatDistribution } from "./format.js";
import {
  OAuthError,
  resolveAuthConfig,
  refreshCredentialsIfNeeded,
  oauthLogin,
  getAuthStatus,
  describeAuthStatus,
  saveApiKey,
  maskKey,
  clearCredentials,
  credentialsPath,
  SWITCH_ACCOUNT_NOTE,
  loadCredentials,
  cleanToken,
  hasOAuthSession,
  signupUrl,
  openBrowserUrl,
  isAllowedPlatformUrl,
} from "./oauth.js";
import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

const PKG_NAME = "@articul8/bivia-mcp";
// read from package.json at run time, so a release bump shows up everywhere (MCP handshake, X-A8-Client-App)
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version || "0.0.0"; } catch { return "0.0.0"; }
})();

// ---------------------------------------------------------------------------
// The Bivia API, through @articul8/bivia.
// ---------------------------------------------------------------------------
class ToolError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// Created on the first tool call (and recreated if the OAuth token refreshes),
// so a missing key does not stop the server from listing its tools.
let client = null;
let clientKey = "";
let clientBase = "";
let clientApp = "";

// Which app made the call (X-A8-Client-App). The gateway's allowlist names the editor this server runs in —
// mcp:claude-code, mcp:codex, mcp:cursor — so take it from the MCP handshake (clientInfo.name); until the
// editor has introduced itself, plain "mcp". Always "<name>/<this package's version>".
let CLIENT_APP = "mcp";
function mcpClientApp(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return "mcp";
  if (/claude[- ]?code/.test(n)) return "mcp:claude-code";
  if (/codex/.test(n)) return "mcp:codex";
  if (/cursor/.test(n)) return "mcp:cursor";
  if (/claude[- ]?(ai|desktop)/.test(n)) return "mcp:claude-desktop";
  if (/visual studio code|vscode|vs code/.test(n)) return "mcp:vscode";
  if (/windsurf/.test(n)) return "mcp:windsurf";
  const slug = n.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug ? "mcp:" + slug : "mcp";
}

async function getAuthedClient() {
  const auth = await resolveAuthConfig();
  if (!auth.apiKey) {
    throw new ToolError(
      "No API key or OAuth session. Call the `bivia_login` tool, run `npx @articul8/bivia-mcp login`, or set A8_API_KEY in the environment.",
      "no_api_key"
    );
  }
  const base = auth.baseURL || "";
  if (!client || clientKey !== auth.apiKey || clientBase !== base || clientApp !== CLIENT_APP) {
    client = new Bivia({
      apiKey: auth.apiKey,
      baseURL: auth.baseURL || undefined,
      maxRetries: 1, // a 503 is a cold start: retry once
      // which app made the call; overrides the SDK's own bivia-node/<version>
      defaultHeaders: { "X-A8-Client-App": `${CLIENT_APP}/${PKG_VERSION}` },
    });
    clientKey = auth.apiKey;
    clientBase = base;
    clientApp = CLIENT_APP;
  }
  return { client, source: auth.source };
}

// @articul8/bivia 1.0.0 ignores `defaultHeaders` (it sends only Authorization + Accept), so X-A8-Client-App
// never left this server. Add it to the SDK's own requests: fetch is wrapped once, and only calls made inside
// callBivia (which tags them through AsyncLocalStorage — safe with concurrent tool calls) get the header. If a
// later SDK sends the header itself, it is left as is.
const sdkCall = new AsyncLocalStorage();
const baseFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const tag = sdkCall.getStore();
  if (!tag) return baseFetch(input, init);
  const headers = new Headers(init.headers || {});
  if (!headers.has("X-A8-Client-App")) headers.set("X-A8-Client-App", tag.clientApp);
  return baseFetch(input, { ...init, headers });
};

async function callBivia(fn) {
  const { client: c, source } = await getAuthedClient();
  const run = (cl) => sdkCall.run({ clientApp: `${CLIENT_APP}/${PKG_VERSION}` }, () => fn(cl));
  try {
    return await run(c);
  } catch (err) {
    if (err instanceof APIError && err.status === 401 && source === "oauth") {
      let refreshed = null;
      try {
        refreshed = await refreshCredentialsIfNeeded({ force: true });
      } catch {
        /* handled below */
      }
      if (refreshed && refreshed.access_token && refreshed.access_token !== clientKey) {
        client = null;
        const { client: retryClient } = await getAuthedClient();
        return await run(retryClient);
      }
      // the sign-in can't be renewed (refresh token expired or revoked) — say what to do
      throw new ToolError(
        "Your Articul8 sign-in has expired. Call the `bivia_login` tool or run `npx @articul8/bivia-mcp login` to sign in again.",
        "oauth_expired"
      );
    }
    if (err instanceof APIError && err.status === 401 && KEY_SOURCES[source]) {
      throw new ToolError(
        `Bivia rejected the API key ${maskKey(clientKey)} (${KEY_SOURCES[source]}). ${KEY_FIXES[source]}`,
        "api_key_rejected"
      );
    }
    throw err;
  }
}

// Where a key came from, for the "rejected" message.
const KEY_SOURCES = {
  api_key: "saved with login --key",
  env: "from the A8_API_KEY / BIVIA_API_KEY environment variable",
  config: "the bivia CLI's key in ~/.bivia/config",
};
// An environment key wins over everything saved, so it has to be fixed where it is set.
const KEY_FIXES = {
  api_key: "Replace it with `npx @articul8/bivia-mcp login --key <KEY>`, or call the `bivia_login` tool to sign in with Articul8.",
  env: "Fix or unset A8_API_KEY / BIVIA_API_KEY in the MCP server's environment.",
  config: "Replace it with `npx @articul8/bivia-mcp login --key <KEY>`, or call the `bivia_login` tool to sign in with Articul8.",
};

// platform_url in a tool call comes from the model: only an Articul8 address or the platform set in
// BIVIA_PLATFORM_URL, so a prompt cannot point the browser or the OAuth flow at another site.
function toolPlatformUrl(raw) {
  if (!raw) return undefined;
  if (!isAllowedPlatformUrl(raw)) {
    throw new ToolError(
      "platform_url must be an Articul8 address (https://*.articul8.ai). To use another platform, set BIVIA_PLATFORM_URL in the MCP server's environment.",
      "invalid_platform_url"
    );
  }
  return raw;
}

// Request defaults: fast mode, the model may abstain, and never think (think:true 500s).
const withDefaults = (body) => ({ domain: null, mode: "fast", allow_abstain: true, ...body, think: false });

// "Test", as in the browser extension popup: one real call with the active credential (and the same body).
const TEST_TEXT = {
  ok: "OK",
  key_rejected: "the API key was rejected",
  sign_in_rejected: "the Articul8 sign-in was rejected; sign in again",
  unauthenticated: "not signed in",
  failed: "the test call failed",
};
// The same test call with a key that is not saved yet (login --key): the key itself, never renewed through
// the sign-in. Returns { ok } or { rejected, why } or { why }.
async function checkKey(key) {
  const saved = loadCredentials();
  const c = new Bivia({
    apiKey: key,
    baseURL: process.env.BIVIA_API_BASE || (saved && saved.api_base) || undefined,
    maxRetries: 1,
    defaultHeaders: { "X-A8-Client-App": `${CLIENT_APP}/${PKG_VERSION}` },
  });
  try {
    await sdkCall.run({ clientApp: `${CLIENT_APP}/${PKG_VERSION}` }, () =>
      c.decisions.boolean(withDefaults({ state: "ok", question: "Does the text say ok?" }))
    );
    return { ok: true };
  } catch (err) {
    const code = errorCode(err);
    return { rejected: code === "http_401" || code === "http_403", why: code };
  }
}

// Returns { test, test_error? }: test is a TEST_TEXT key; test_error keeps the error code of a failed call.
async function testConnection() {
  try {
    await callBivia((c) => c.decisions.boolean(withDefaults({ state: "ok", question: "Does the text say ok?" })));
    return { test: "ok" };
  } catch (err) {
    const code = errorCode(err);
    if (code === "api_key_rejected") return { test: "key_rejected" };
    if (code === "oauth_expired") return { test: "sign_in_rejected" };
    if (code === "no_api_key") return { test: "unauthenticated" };
    if (code === "http_401" || code === "http_403") {
      return { test: getAuthStatus().method === "oauth" ? "sign_in_rejected" : "key_rejected" };
    }
    return { test: "failed", test_error: code };
  }
}

// ---------------------------------------------------------------------------
// Shared JSON-schema fragments.
// ---------------------------------------------------------------------------
const STATE = {
  type: "string",
  description:
    "The situation/context as plain text (NOTE: a plain string). Optional for most endpoints.",
};
const QUESTION = {
  type: "string",
  description: "The question to decide. Required.",
};

// ---------------------------------------------------------------------------
// Tool definitions: { name, description, inputSchema (JSON Schema), run }.
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "bivia_boolean",
    description:
      "Ask Bivia a yes/no question and get a calibrated true/false with confidence. Use for binary decisions.",
    inputSchema: {
      type: "object",
      properties: { state: STATE, question: QUESTION },
      required: ["question"],
    },
    run: (a) =>
      callBivia((c) =>
        c.decisions.boolean(withDefaults({ state: a.state ?? "", question: a.question }))
      ),
  },
  {
    name: "bivia_choice",
    description:
      "Pick the single best option from a list of choices, with a calibrated distribution over all of them. Also drives optimization loops (choices = candidate actions).",
    inputSchema: {
      type: "object",
      properties: {
        state: STATE,
        question: QUESTION,
        choices: {
          type: "array",
          items: { type: "string" },
          description: "The candidate options to choose from. Required.",
        },
      },
      required: ["question", "choices"],
    },
    run: (a) =>
      callBivia((c) =>
        c.decisions.choice(
          withDefaults({ state: a.state ?? "", question: a.question, choices: a.choices })
        )
      ),
  },
  {
    name: "bivia_score",
    description:
      "Rate something on a numeric range (e.g. 0-10). Returns the chosen score and a per-bucket distribution.",
    inputSchema: {
      type: "object",
      properties: {
        state: STATE,
        question: QUESTION,
        range: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
          description: "[min, max] of the scoring range. Optional (defaults apply).",
        },
      },
      required: ["question"],
    },
    run: (a) =>
      callBivia((c) =>
        c.decisions.score(
          withDefaults({
            state: a.state ?? "",
            question: a.question,
            buckets: 11,
            ...(a.range ? { range: a.range } : {}),
          })
        )
      ),
  },
  {
    name: "bivia_set",
    description:
      "Pick the valid SUBSET of options (zero, one, or many may apply). Returns the chosen set and a distribution.",
    inputSchema: {
      type: "object",
      properties: {
        state: STATE,
        question: QUESTION,
        options: {
          type: "array",
          items: { type: "string" },
          description: "The candidate options; any valid subset may be selected. Required.",
        },
      },
      required: ["question", "options"],
    },
    run: (a) =>
      callBivia((c) =>
        c.decisions.multiSelect(
          withDefaults({ state: a.state ?? "", question: a.question, options: a.options })
        )
      ),
  },
  {
    name: "bivia_span",
    description:
      "Localize the text evidence that answers the question. Returns verbatim quotes with character offsets into `state`. `state` is required here.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "The text to find evidence in. REQUIRED for span.",
        },
        question: QUESTION,
      },
      required: ["state", "question"],
    },
    run: (a) =>
      callBivia((c) =>
        c.decisions.span(withDefaults({ state: a.state, question: a.question }))
      ),
  },
  {
    name: "bivia_decide",
    description:
      "Generic typed decision across arbitrary outcomes. Returns the chosen outcome and a distribution.",
    inputSchema: {
      type: "object",
      properties: {
        state: STATE,
        question: QUESTION,
        outcomes: {
          type: "array",
          items: { type: "string" },
          description: "The candidate outcomes to decide among. Required.",
        },
      },
      required: ["question", "outcomes"],
    },
    run: (a) =>
      callBivia((c) =>
        c.decisions.create(
          withDefaults({ state: a.state ?? "", question: a.question, outcomes: a.outcomes })
        )
      ),
  },
  {
    name: "bivia_ground",
    description:
      "Visual grounding: find and localize regions in an image. Returns labeled bounding boxes (coords normalized [0,1000]).",
    inputSchema: {
      type: "object",
      properties: {
        question: QUESTION,
        image: {
          type: "object",
          description: "One image, by URL or base64.",
          properties: {
            url: { type: "string", description: "Image URL." },
            b64: { type: "string", description: "Base64-encoded image bytes." },
            mime: { type: "string", description: 'MIME type, e.g. "image/png".' },
          },
        },
      },
      required: ["question", "image"],
    },
    run: (a) =>
      callBivia((c) =>
        c.grounding.image(
          withDefaults({ state: "", question: a.question, images: a.image ? [a.image] : [] })
        )
      ),
  },
  {
    name: "bivia_ds",
    description:
      "Data-science / signal decision over numeric time-series. The host CPU profiler folds a data profile into state; you send raw numbers.",
    inputSchema: {
      type: "object",
      properties: {
        question: QUESTION,
        signals: {
          type: "array",
          description:
            'Signals: [{ name, data:[channels][samples], fs?, dtype:"float32" }]. Required.',
          items: { type: "object" },
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Candidate methods/answers. Required.",
        },
        kind: {
          type: "string",
          enum: ["choice", "set", "boolean"],
          description: 'How to decide (default "choice").',
        },
      },
      required: ["question", "signals", "options"],
    },
    run: (a) =>
      callBivia((c) =>
        c.data.decide(
          withDefaults({
            state: "",
            question: a.question,
            signals: a.signals,
            options: a.options,
            kind: a.kind ?? "choice",
          })
        )
      ),
  },
  {
    name: "bivia_login",
    description:
      "Sign in to Articul8 Bivia in your browser using OAuth 2.1 + PKCE, select your Tenant and Group scopes on the consent screen, and save credentials to ~/.bivia/credentials.json.",
    inputSchema: {
      type: "object",
      properties: {
        platform_url: {
          type: "string",
          description:
            "Optional Articul8 platform URL: an https://*.articul8.ai address or the BIVIA_PLATFORM_URL value (defaults to BIVIA_PLATFORM_URL or https://app.articul8.ai).",
        },
        switch_account: {
          type: "boolean",
          description:
            "Sign in again to pick another organization, tenant or group (or another account, after signing out of Articul8 in the browser).",
        },
      },
    },
    run: async (a) => {
      const creds = await oauthLogin({
        platformUrl: toolPlatformUrl(a.platform_url),
        clientName: "Bivia MCP Server",
        switchAccount: Boolean(a.switch_account),
      });
      client = null;
      const signedIn = `Signed in to tenant ${creds.tenant_id || "default"} (group: ${creds.group_id || "default"}, permission: ${creds.permission || "write"})`;
      return {
        type: "auth",
        status: "authenticated",
        value: a.switch_account ? `${signedIn}. ${SWITCH_ACCOUNT_NOTE}` : signedIn,
        tenant_id: creds.tenant_id,
        group_id: creds.group_id,
        group_ids: creds.group_ids,
        permission: creds.permission,
        scope: creds.scope,
      };
    },
  },
  {
    name: "bivia_signup",
    description:
      "Create a free Articul8 account: opens the Articul8 sign-up page in the browser. Once the account exists, call bivia_login to sign in.",
    inputSchema: {
      type: "object",
      properties: {
        platform_url: {
          type: "string",
          description:
            "Optional Articul8 platform URL: an https://*.articul8.ai address or the BIVIA_PLATFORM_URL value (defaults to BIVIA_PLATFORM_URL or https://app.articul8.ai).",
        },
      },
    },
    run: async (a) => {
      if (hasOAuthSession()) {
        throw new ToolError(
          "Already signed in to Articul8. Call `bivia_login` with switch_account to use another organization or account.",
          "already_signed_in"
        );
      }
      const url = signupUrl(toolPlatformUrl(a.platform_url));
      openBrowserUrl(url);
      return {
        type: "auth",
        status: "signup_opened",
        value: `Open the Articul8 sign-up page in your browser (opened automatically when this machine can): ${url} — once your account is ready, call bivia_login to sign in.`,
        url,
      };
    },
  },
  {
    name: "bivia_auth_status",
    description:
      "Check the active Articul8 Bivia authentication status: a sign-in (tenant, group, permission) or an API key (masked), and the endpoint. Set test to make one real call with it (a normal, billed Bivia call; use it when asked, not on every turn).",
    inputSchema: {
      type: "object",
      properties: {
        test: {
          type: "boolean",
          description: "Also make one real (billed) Bivia call to check the credential works.",
        },
      },
    },
    run: async (a) => {
      const st = getAuthStatus();
      const t = a.test ? await testConnection() : null;
      const testText = t ? `. Test: ${TEST_TEXT[t.test]}${t.test_error ? ` (${t.test_error})` : ""}` : "";
      return {
        type: "auth",
        status: st.authenticated ? "authenticated" : "unauthenticated",
        value: describeAuthStatus(st) + testText,
        ...st,
        ...(t || {}),
      };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Render a response envelope into MCP content (text + structured).
// ---------------------------------------------------------------------------
function renderResult(res) {
  const lines = [formatAnswer(res)];
  const dist = formatDistribution(res);
  if (dist) lines.push("", "distribution:", dist);
  if (res && res.status) lines.push("", `status: ${res.status}`);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: res,
  };
}

function errorCode(err) {
  if (err instanceof APIConnectionError) return "network_error";
  if (err instanceof APIError && err.status) return `http_${err.status}`;
  if (err instanceof OAuthError && err.code) return err.code;
  return (err && err.code) || "error";
}

function renderError(err) {
  const code = errorCode(err);
  const hint =
    code === "no_api_key" || code === "api_key_rejected"
      ? ""
      : "\n(If this is a connectivity error, check your internet connection and BIVIA_API_BASE.)";
  return {
    isError: true,
    content: [{ type: "text", text: `Bivia error [${code}]: ${err.message}${hint}` }],
  };
}

// ---------------------------------------------------------------------------
// Wire up the stdio server & CLI auth subcommands.
// ---------------------------------------------------------------------------
const SERVER_INSTRUCTIONS = [
  "Bivia is a calibrated decision engine. Use it when you need a structured, calibrated decision (with probabilities and honest abstention) rather than a free-form guess.",
  "Tool selection: bivia_boolean (yes/no), bivia_choice (pick one from a list), bivia_score (numeric rating on a range), bivia_set (multi-select subset), bivia_span (exact supporting text offsets in state), bivia_decide (auto-detect type), bivia_ground (bounding boxes in an image), bivia_ds (raw numeric signals).",
  "Always pass relevant context in `state` as plain text. When `status` is \"abstained\" (reported as \"unsure\"), do not fabricate a pick — gather more context or escalate to the user.",
  "If a call reports missing credentials, guide the user to run `bivia_login` (or `bivia_signup` if they need an account) or set A8_API_KEY.",
].join("\n");

const server = new Server(
  { name: PKG_NAME, version: PKG_VERSION },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

// once the editor has introduced itself, every Bivia call names it (X-A8-Client-App: mcp:<editor>/<version>)
server.oninitialized = () => {
  const info = server.getClientVersion();
  CLIENT_APP = mcpClientApp(info && info.name);
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    return renderError(new ToolError(`Unknown tool: ${name}`, "unknown_tool"));
  }
  try {
    const res = await tool.run(args);
    return renderResult(res);
  } catch (err) {
    return renderError(err);
  }
});

async function browserLogin(platformUrl, switchAccount) {
  console.error("Opening browser to sign in to Articul8 Bivia...");
  const creds = await oauthLogin({
    platformUrl: platformUrl || undefined,
    clientName: "Bivia MCP Server",
    switchAccount,
    onAuthUrl: (url) => {
      console.error(`If your browser does not open automatically, visit:\n  ${url}\n`);
    },
  });
  console.error(
    `✓ Signed in to Articul8 (tenant: ${creds.tenant_id || "default"}, group: ${creds.group_id || "default"}, permission: ${creds.permission || "write"})`
  );
  console.error(`Credentials saved to ${credentialsPath()}`);
  if (switchAccount) console.error(SWITCH_ACCOUNT_NOTE);
}

function waitForEnter(prompt) {
  console.error(prompt);
  return new Promise((resolve) => {
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

// login --key. credentials.json is shared with the bivia CLI, which reads it first, so a key replaces a
// sign-in (or a saved key) only once one test call accepts it, or with --force: a mistyped or revoked key
// never destroys a working sign-in. With nothing to replace, the key is saved without a call. Same rule
// as `bivia key`.
async function saveKey(raw, force) {
  const key = cleanToken(raw);
  if (!key) throw new OAuthError("The API key is empty", "empty_api_key");
  const current = loadCredentials();
  const replacing = Boolean(current && current.access_token);
  if (replacing && !force) {
    const check = await checkKey(key);
    if (!check.ok) {
      console.error(
        check.rejected
          ? `Bivia rejected this key (${check.why}). Nothing changed: your current sign-in or key is kept.`
          : `Could not check this key (${check.why}). Nothing changed: your current sign-in or key is kept.`
      );
      console.error("Check the key, or run `npx @articul8/bivia-mcp login --key <KEY> --force` to replace it anyway.");
      process.exitCode = 1;
      return;
    }
  }
  saveApiKey(key);
  console.error(`Saved API key to ${credentialsPath()}.`);
  if (hasOAuthSession(current)) console.error(`It replaces the Articul8 sign-in (tenant ${current.tenant_id || "unknown"}).`);
  else if (replacing) console.error("It replaces the key saved before.");
}

async function runCliCommand(argv) {
  const cmd = argv[0];
  if (cmd === "login") {
    let platformUrl = "";
    let manualKey = null;
    let switchAccount = false;
    let force = false;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--platform" && argv[i + 1]) platformUrl = argv[++i];
      // --key by presence: an empty or missing value is an error, never a fall-through to the browser login
      else if (argv[i] === "--key") manualKey = argv[++i] ?? "";
      else if (argv[i] === "--switch") switchAccount = true;
      else if (argv[i] === "--force") force = true;
    }
    if (manualKey !== null) {
      await saveKey(manualKey, force);
      return true;
    }
    await browserLogin(platformUrl, switchAccount);
    return true;
  }
  if (cmd === "signup") {
    let platformUrl = "";
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--platform" && argv[i + 1]) platformUrl = argv[++i];
    }
    if (hasOAuthSession()) {
      console.error("Already signed in to Articul8. Use `npx @articul8/bivia-mcp login --switch` to use another organization or account.");
      process.exitCode = 1;
      return true;
    }
    const url = signupUrl(platformUrl || undefined);
    console.error(`Opening the Articul8 sign-up page:\n  ${url}\n`);
    openBrowserUrl(url);
    if (!process.stdin.isTTY) {
      console.error("Once your account is ready, run `npx @articul8/bivia-mcp login` to sign in.");
      return true;
    }
    await waitForEnter("Press Enter once your account is ready to sign in...");
    await browserLogin(platformUrl, false);
    return true;
  }
  if (cmd === "logout") {
    clearCredentials();
    console.error("✓ Signed out and cleared ~/.bivia credentials.");
    return true;
  }
  if (cmd === "status") {
    const st = getAuthStatus();
    if (argv.includes("--test")) {
      Object.assign(st, await testConnection());
      if (st.test !== "ok") process.exitCode = 1;
    }
    console.log(JSON.stringify(st, null, 2));
    return true;
  }
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length > 0 && ["login", "signup", "logout", "status"].includes(argv[0])) {
    await runCliCommand(argv);
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs go to stderr so they never corrupt the stdio JSON-RPC stream.
  console.error(`${PKG_NAME} v${PKG_VERSION} running on stdio (${TOOLS.length} tools).`);
}

main().catch((err) => {
  // an auth problem (timeout, denied consent, empty key, bad platform URL) is one line, not a stack trace
  if (err instanceof OAuthError) console.error(`Error: ${err.message}`);
  else console.error("Fatal:", err);
  process.exit(1);
});
