# Agent Email

[![npm version](https://img.shields.io/npm/v/email-agent-mcp)](https://www.npmjs.com/package/email-agent-mcp)
[![npm downloads](https://img.shields.io/npm/dm/email-agent-mcp.svg)](https://npmjs.org/package/email-agent-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml)
[![codecov](https://img.shields.io/codecov/c/github/UseJunior/email-agent-mcp/main)](https://app.codecov.io/gh/UseJunior/email-agent-mcp)
[![GitHub stargazers](https://img.shields.io/github/stars/UseJunior/email-agent-mcp?style=social)](https://github.com/UseJunior/email-agent-mcp/stargazers)
[![Tests: Vitest](https://img.shields.io/badge/tests-vitest-6E9F18)](https://vitest.dev/)
[![OpenSpec Traceability](https://img.shields.io/badge/openspec-traceability%20gate-brightgreen)](./scripts/check-spec-coverage.mjs)
[![Socket Badge](https://socket.dev/api/badge/npm/package/email-agent-mcp)](https://socket.dev/npm/package/email-agent-mcp)
[![install size](https://img.shields.io/npm/unpacked-size/email-agent-mcp)](https://www.npmjs.com/package/email-agent-mcp)

[English](./README.md) | [Español](./README.es.md) | [简体中文](./README.zh.md) | [Português (Brasil)](./README.pt-br.md) | [Deutsch](./README.de.md)

**email-agent-mcp** by [UseJunior](https://usejunior.com) -- local email connectivity for AI agents.

Agent Email is an open-source TypeScript MCP server that lets Claude Code, Cursor, Gemini CLI, OpenClaw, and other MCP-compatible runtimes read email, search threads, draft replies, label messages, change read state, move messages, and send mail through your own mailbox. Microsoft 365 / Outlook and Gmail are supported today. Security-first defaults mean agents cannot send email until you explicitly configure an allowlist.

## Quick Start

```bash
npx -y email-agent-mcp
```

The interactive setup wizard walks you through OAuth configuration and mailbox selection.

## What Works Today

- Microsoft 365 / Outlook mailbox access through MCP stdio
- `list_emails`, `read_email`, `search_emails`, and `get_thread`
- `create_draft`, `update_draft`, `send_draft`, `send_email`, and `reply_to_email`
- `label_email`, `mark_read`, and `move_to_folder`
- send allowlists, delete disabled by default, and sanitized errors

The current launch-prep pass was validated against a real Outlook mailbox for read, draft, send, categorize, move, and read-state flows.

## Why This Exists

AI agents need to read, reply to, and act on email, but email APIs are complex. OAuth flows, Graph delta queries, Gmail push subscriptions, HTML-to-markdown conversion, threading semantics -- each provider has its own quirks.

Agent Email wraps this complexity into deterministic MCP tools with security guardrails:

- send and receive allowlists that control who agents can contact
- delete disabled by default (requires explicit opt-in)
- error sanitization that strips API keys, file paths, and stack traces
- body file sandboxing with path traversal protection

## Use with Claude Code

Add to `~/.claude/settings.json` or your project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "email-agent-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "email-agent-mcp"]
    }
  }
}
```

## Use with Cursor

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "email-agent-mcp": {
      "command": "npx",
      "args": ["-y", "email-agent-mcp"]
    }
  }
}
```

## Use with Gemini CLI

```bash
gemini extensions install https://github.com/UseJunior/email-agent-mcp
```

## Use with OpenClaw

Add an `mcp` block to `~/.openclaw/openclaw.json`:

```json5
{
  // ... existing config ...
  mcp: {
    servers: {
      email: {
        command: "npx",
        args: ["tsx", "/path/to/email-agent-mcp/packages/email-mcp/src/serve-entry.ts"],
        transport: "stdio"
      }
    }
  }
}
```

> **Version note**: The `mcp` config key requires OpenClaw app >= 2026.3.24. If the CLI is older than the app, it may reject this key during validation even though the gateway accepts it. Update the CLI with `npm install openclaw@latest` in your NemoClaw directory, or restart the gateway directly with `launchctl kickstart -k gui/501/ai.openclaw.gateway`.

### Email watcher

The watcher polls your mailbox and sends wake signals to OpenClaw when new email arrives:

```bash
# Set the hooks token (must match hooks.token in openclaw.json)
export OPENCLAW_HOOKS_TOKEN="your-hooks-token"

# Start the watcher (defaults to http://localhost:18789/hooks/wake)
npm run dev:watch
```

The watcher requires at least one configured mailbox. Run `npx email-agent-mcp` or `npm run dev:configure` first to complete the OAuth flow.

## Launch Prep Smoke Test

Before recording a demo, run the live smoke script against a real mailbox and a safe send allowlist. The script exercises:

- `get_mailbox_status`
- `list_emails` + `read_email`
- `mark_read` unread -> read -> unread
- `label_email` on a safe inbox candidate
- `create_draft`
- draft-only `reply_to_email`
- optional `send_email`

Example:

```bash
EMAIL_AGENT_MCP_HOME=/tmp/email-agent-mcp-live \
AGENT_EMAIL_SEND_ALLOWLIST=/tmp/email-agent-mcp-live/send-allowlist.json \
npm run launch:prep:smoke -- --live-write --send-to beta@usejunior.com
```

Default safe-candidate selection looks for `notifications@github.com` in the inbox so you can rehearse the recording flow on a public-safe message instead of customer mail.
If your mailbox status name is not an email address, pass `--reply-sender <email>` or set `EMAIL_AGENT_MCP_REPLY_SENDER` so the script can find a self-sent message for the draft-reply check.

## Tool Reference

Agent Email exposes 15 MCP tools:

| Tool | Description | Type |
|------|-------------|------|
| `list_emails` | List recent emails with filtering | read |
| `read_email` | Read full email content as markdown | read |
| `search_emails` | Full-text search across mailboxes | read |
| `get_mailbox_status` | Connection status and warnings | read |
| `get_thread` | Full conversation context | read |
| `send_email` | Send new email (allowlist-gated) | write |
| `reply_to_email` | Reply with RFC threading | write |
| `create_draft` | Create email draft | write |
| `update_draft` | Update draft content | write |
| `send_draft` | Send a saved draft | write |
| `label_email` | Apply labels/categories | write |
| `flag_email` | Flag/unflag emails | write |
| `mark_read` | Mark as read/unread | write |
| `move_to_folder` | Move between folders | write |
| `delete_email` | Delete (requires opt-in) | destructive |

## Provider Support

| Provider | Status | Package |
|----------|--------|---------|
| Microsoft 365 (Graph API) | Fully supported | `@usejunior/provider-microsoft` |
| Gmail | Supported via interactive CLI OAuth or manual refresh-token setup | `@usejunior/provider-gmail` |

Use `email-agent-mcp configure --provider gmail` to run the local browser OAuth flow, or add a manual mailbox token file under `~/.email-agent-mcp/tokens/`. See [packages/provider-gmail/README.md](./packages/provider-gmail/README.md).

## Security Defaults

Agent Email ships with restrictive defaults that you loosen as needed:

- **Send allowlist**: empty by default -- agents cannot send email until you add recipients
- **Receive allowlist**: accepts all by default -- controls which senders trigger the watcher
- **Delete disabled**: agents cannot delete email unless you set `user_explicitly_requested_deletion: true`
- **Error sanitization**: API keys, file paths, and stack traces are redacted from error responses
- **Body file sandboxing**: no `../` traversal, no symlinks, binary detection

## Packages

| Package | Description |
|---------|-------------|
| `@usejunior/email-core` | Core email actions, content engine, security, and provider interfaces |
| `@usejunior/email-mcp` | MCP server adapter, CLI, and watcher |
| `@usejunior/provider-microsoft` | Microsoft Graph API email provider |
| `@usejunior/provider-gmail` | Gmail API email provider |
| `email-agent-mcp` | Distribution wrapper (`npx email-agent-mcp`) |

## Quality and Trust Signals

- CI runs on every pull request and push to main (lint, typecheck, tests on Node 20 + 22)
- CodeQL and Semgrep security scanning
- Coverage published to Codecov
- OpenSpec traceability enforcement via `npm run check:spec-coverage`
- 300+ tests across the suite
- Maintainer: [Steven Obiajulu](https://www.linkedin.com/in/steven-obiajulu/)

## Architecture

```
email-agent-mcp/
├── packages/
│   ├── email-core          Core actions, content engine, security
│   ├── email-mcp           MCP server adapter, CLI, watcher
│   ├── provider-microsoft  Microsoft Graph provider
│   ├── provider-gmail      Gmail API provider
│   └── email-agent-mcp         Distribution wrapper (npx entry point)
├── openspec/               Spec-driven development
└── scripts/                CI and validation scripts
```

## Releasing

Tag-driven release via GitHub Actions with npm OIDC trusted publishing. All 5 packages publish in dependency order with `--provenance`, then `server.json` is published to the official MCP Registry with `mcp-publisher`.

## FAQ

### Does this work with Claude Code?

Yes. Run `npx email-agent-mcp` to start the MCP server, then configure it in your Claude Code settings.

### Can agents send email without my permission?

No. The send allowlist is empty by default. Agents cannot send any email until you explicitly configure allowed recipients.

### Does this store my email credentials?

OAuth tokens are managed by MSAL (Microsoft) and stored in your OS keychain or local config files under `~/.email-agent-mcp/`. Agent Email never stores raw passwords.

### Can I connect multiple mailboxes?

Yes. You can configure Microsoft 365 and Gmail simultaneously. Read actions default to your primary mailbox; write actions require specifying a mailbox when multiple are configured.

### The OpenClaw CLI rejects my config with "Unrecognized key: mcp"

The OpenClaw CLI and macOS app can be different versions. The app (which runs the gateway) may support config keys the CLI doesn't recognize yet. Update the CLI: `cd ~/Projects/NemoClaw && npm install openclaw@latest`. Alternatively, restart the gateway directly: `launchctl kickstart -k gui/501/ai.openclaw.gateway`.

### The watcher starts but finds zero mailboxes

Mailbox credentials are stored in `~/.email-agent-mcp/tokens/`. If this directory is empty, run `npx email-agent-mcp` or `npm run dev:configure` to authenticate via OAuth. The watcher will exit with no mailboxes to poll until at least one is configured.

### OpenClaw says "Demo mode -- run email-agent-mcp configure to connect"

The MCP server is running but has no real mailbox credentials. Run `npx email-agent-mcp` to complete the interactive OAuth setup, then restart the OpenClaw gateway so the MCP server reconnects with valid tokens.

### Token expired after a week even though I just authenticated

Microsoft refresh tokens typically last 90 days, but your Azure AD tenant may enforce shorter lifetimes. The code uses MSAL with OS keychain persistence (`@azure/identity-cache-persistence`), which handles silent token refresh automatically. If MSAL reports `interaction_required` or `invalid_grant`, re-run `npx email-agent-mcp` to re-authenticate. Common causes: conditional access policies, MFA re-verification requirements, or admin-configured token lifetime policies.

### OpenClaw Telegram bot receives messages but doesn't respond

Verify the Telegram channel is healthy with `openclaw status`. If the channel shows OK but no responses come back, check that: (1) your Telegram user ID is in `channels.telegram.allowFrom` in `openclaw.json`, (2) a binding exists matching `channel: "telegram"`, and (3) the gateway was restarted after config changes. For one-owner bots, use `dmPolicy: "allowlist"` with explicit `allowFrom` IDs rather than relying on pairing approvals.

## Development

```bash
npm ci
npm run build
npm run lint --workspaces --if-present
npm run test:run
npm run check:spec-coverage
```

## See Also

- [Safe DOCX Suite](https://github.com/UseJunior/safe-docx) -- surgical editing of Word documents with coding agents
- [Open Agreements](https://github.com/open-agreements/open-agreements) -- fill standard legal templates with coding agents

## Privacy

Agent Email runs entirely on your local machine. Email credentials are stored in your OS keychain (MSAL) and local config files. No email content is sent to external servers by Agent Email itself.

## Governance

- [Contributing Guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
