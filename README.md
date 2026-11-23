# Bivia MCP Server

[![CI](https://github.com/articul8/bivia-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/articul8/bivia-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@articul8/bivia-mcp)](https://www.npmjs.com/package/@articul8/bivia-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [Bivia](https://articul8.ai/bivia) by [Articul8 AI](https://articul8.ai). See [bivia](https://github.com/articul8/bivia) for full documentation, cookbooks, and SDKs.

Bivia is a calibrated decision engine that returns typed, structured answers with calibrated probabilities, source evidence, and honest abstention (`unsure`) when the model is not confident enough. Connect this MCP server to **Claude Code, Codex, VS Code, Cursor, Claude Desktop**, or any MCP-compatible host over stdio via `npx`.

## Requirements

- **Node.js >= 18**
- An Articul8 account (OAuth sign-in) or `A8_API_KEY` ([get an API key](https://app.articul8.ai/registration?source=bivia&code=bivia))

## Quick start

Sign in once with your Articul8 account (or set `A8_API_KEY`):

```bash
npx -y @articul8/bivia-mcp login
```

Need an account? Run `npx -y @articul8/bivia-mcp signup` to open the free sign-up page.

Then add the server to your MCP client:

### Claude Code

With OAuth sign-in (recommended):

```bash
claude mcp add bivia -- npx -y @articul8/bivia-mcp
```

Or with an API key:

```bash
claude mcp add bivia --env A8_API_KEY=YOUR_KEY -- npx -y @articul8/bivia-mcp
```

Verify with `/mcp` inside Claude Code — you should see `bivia` with 11 tools.

### Codex

```bash
codex mcp add bivia -- npx -y @articul8/bivia-mcp
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.bivia]
command = "npx"
args = ["-y", "@articul8/bivia-mcp"]

# Optional if not using OAuth login:
[mcp_servers.bivia.env]
A8_API_KEY = "YOUR_KEY"
```

### VS Code

From the command line:

```bash
code --add-mcp '{"name":"bivia","type":"stdio","command":"npx","args":["-y","@articul8/bivia-mcp"]}'
```

Or create `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "bivia": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@articul8/bivia-mcp"]
    }
  }
}
```

### Cursor / Claude Desktop

Add to your MCP config (`~/.cursor/mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bivia": {
      "command": "npx",
      "args": ["-y", "@articul8/bivia-mcp"],
      "env": {
        "A8_API_KEY": "YOUR_KEY"
      }
    }
  }
}
```

*(Omit `env` if you signed in with `npx -y @articul8/bivia-mcp login`.)*

> **Tip:** Pin a version in shared team configs (e.g. `@articul8/bivia-mcp@1.1.0`) for reproducible installs.

## Tools

### Decision & evidence tools

| Tool | When to use | Key inputs |
|---|---|---|
| `bivia_boolean` | Binary yes/no judgment with calibrated probability | `question`, `state?` |
| `bivia_choice` | Pick one best option from a candidate list (classification, routing, next action) | `question`, `choices[]`, `state?` |
| `bivia_score` | Rate severity, risk, urgency, or quality on a numeric scale | `question`, `range?: [min, max]`, `state?` |
| `bivia_set` | Multi-select: return every option that applies (zero, one, or many) | `question`, `options[]`, `state?` |
| `bivia_span` | Locate exact supporting passages in `state` with character offsets | `question`, `state` |
| `bivia_decide` | Auto-detect the right decision type when the answer format isn't fixed | `question`, `outcomes[]?`, `state?` |
| `bivia_ground` | Locate objects in an image and return normalized `[0, 1000]` bounding boxes | `question`, `image: { url \| b64, mime }` |
| `bivia_ds` | Make a decision over raw numeric / sensor signals | `question`, `signals[]`, `options[]?`, `kind?` |

### Account tools

| Tool | Purpose | Key inputs |
|---|---|---|
| `bivia_login` | Sign in via browser (OAuth 2.1 + PKCE); set `switch_account: true` to pick another organization | `switch_account?` |
| `bivia_signup` | Open the free Articul8 sign-up page | — |
| `bivia_auth_status` | Show active account/key status; set `test: true` to run a live check | `test?` |

## Using with AI agents

- **Every decision returns a calibrated answer and full envelope:** Each tool returns a human-readable summary (`value` + confidence) along with the structured JSON response (`value`, `probability`, `distribution`, `status`, `evidence`).
- **Honest abstention (`unsure`):** When Bivia lacks sufficient confidence, `status` is `"abstained"` and `value` is `null` (reported as `"unsure"`). Agents should treat abstention as a signal to gather more context or escalate to a human rather than guessing.
- **Zero-config discovery:** Tools are always listable even before signing in; authentication is only checked when a decision tool is called.
- **Built-in guidance & Agent Skill:** The server sends MCP `instructions` on initialization so hosts know how to select tools and respect abstention. For hosts that support the open Agent Skills format (Claude Code, Codex, Cursor, Antigravity), a ready-to-use skill is also included at [`skills/bivia/SKILL.md`](skills/bivia/SKILL.md).

## Authentication & CLI commands

You can authenticate with OAuth 2.1 (stored in `~/.bivia/credentials.json`, auto-refreshed and shared with the `bivia` CLI) or with an API key (`A8_API_KEY`).

| Command | Description |
|---|---|
| `npx -y @articul8/bivia-mcp signup` | Open the free Articul8 sign-up page and sign in |
| `npx -y @articul8/bivia-mcp login` | Sign in via browser (OAuth 2.1 + PKCE) |
| `npx -y @articul8/bivia-mcp login --switch` | Switch organization, tenant, or group |
| `npx -y @articul8/bivia-mcp login --key YOUR_KEY` | Verify and save an API key (`--force` skips verification) |
| `npx -y @articul8/bivia-mcp status [--test]` | Show connection status (`--test` makes one live call) |
| `npx -y @articul8/bivia-mcp logout` | Clear saved credentials |

## Configuration

| Environment variable | Description | Default |
|---|---|---|
| `A8_API_KEY` | API key (overrides saved OAuth credentials) | — |
| `BIVIA_API_BASE` | Override the Bivia API base URL | `https://api.articul8.ai/bivia` |
| `BIVIA_PLATFORM_URL` | Override the Articul8 OAuth login URL | `https://app.articul8.ai` |

## Programmatic use

To call the Bivia API directly from your own application code, use one of the official SDKs (for Node.js/TypeScript, [`@articul8/bivia`](https://www.npmjs.com/package/@articul8/bivia)):

```js
import Bivia from "@articul8/bivia";

const client = new Bivia(); // reads $A8_API_KEY
const res = await client.decisions.choice({
  question: "Which team owns this?",
  choices: ["Infra", "Billing"],
});
console.log(res.value, res.probability);
```

See [articul8/bivia](https://github.com/articul8/bivia) for Python, Go, and Rust SDKs.

## License

Apache-2.0. See [LICENSE](LICENSE).
