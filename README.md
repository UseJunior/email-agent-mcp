# Agent Email

[![npm version](https://img.shields.io/npm/v/@usejunior/email-agent-mcp)](https://www.npmjs.com/package/@usejunior/email-agent-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@usejunior/email-agent-mcp.svg)](https://npmjs.org/package/@usejunior/email-agent-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml)
[![codecov](https://img.shields.io/codecov/c/github/UseJunior/email-agent-mcp/main)](https://app.codecov.io/gh/UseJunior/email-agent-mcp)
[![GitHub stargazers](https://img.shields.io/github/stars/UseJunior/email-agent-mcp?style=social)](https://github.com/UseJunior/email-agent-mcp/stargazers)
[![Tests: Vitest](https://img.shields.io/badge/tests-vitest-6E9F18)](https://vitest.dev/)
[![OpenSpec Traceability](https://img.shields.io/badge/openspec-traceability%20gate-brightgreen)](./scripts/check-spec-coverage.mjs)
[![Socket Badge](https://socket.dev/api/badge/npm/package/@usejunior/email-agent-mcp)](https://socket.dev/npm/package/@usejunior/email-agent-mcp)
[![install size](https://packagephobia.com/badge?p=@usejunior/email-agent-mcp)](https://packagephobia.com/result?p=@usejunior/email-agent-mcp)

[English](./README.md) | [Español](./README.es.md) | [简体中文](./README.zh.md) | [Português (Brasil)](./README.pt-br.md) | [Deutsch](./README.de.md)

**email-agent-mcp** by [UseJunior](https://usejunior.com) -- email connectivity for AI agents.

Agent Email is an open-source TypeScript MCP server that gives AI agents secure access to email. It exposes email operations via [Model Context Protocol](https://modelcontextprotocol.io/) for any MCP-compatible agent runtime -- Claude Code, Gemini CLI, Cursor, Goose, and more. Security-first defaults mean agents cannot send email until you explicitly configure an allowlist.

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
      "args": ["-y", "@usejunior/email-agent-mcp"]
    }
  }
}
```

## Use with Gemini CLI

```bash
gemini extensions install https://github.com/UseJunior/email-agent-mcp
```

## Use with Cursor

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "email-agent-mcp": {
      "command": "npx",
      "args": ["-y", "@usejunior/email-agent-mcp"]
    }
  }
}
```

## Use with CLI

```bash
npx -y @usejunior/email-agent-mcp
```

The interactive setup wizard walks you through OAuth configuration and mailbox selection.

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
| Gmail | Coming soon | `@usejunior/provider-gmail` |

The Gmail provider package exists with full test coverage. Wiring into the MCP server is in progress.

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
| `@usejunior/email-agent-mcp` | Distribution wrapper (`npx @usejunior/email-agent-mcp`) |

## Quality and Trust Signals

- CI runs on every pull request and push to main (lint, typecheck, tests on Node 20 + 22)
- CodeQL and Semgrep security scanning
- Coverage published to Codecov
- OpenSpec traceability enforcement via `npm run check:spec-coverage`
- 310 tests across 34 test files
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

Tag-driven release via GitHub Actions with npm OIDC trusted publishing. All 5 packages publish in dependency order with `--provenance`.

## FAQ

### Does this work with Claude Code?

Yes. Run `npx @usejunior/email-agent-mcp` to start the MCP server, then configure it in your Claude Code settings.

### Can agents send email without my permission?

No. The send allowlist is empty by default. Agents cannot send any email until you explicitly configure allowed recipients.

### Does this store my email credentials?

OAuth tokens are managed by MSAL (Microsoft) and stored in your OS keychain or local config files under `~/.email-agent-mcp/`. Agent Email never stores raw passwords.

### Can I connect multiple mailboxes?

Yes. You can configure Microsoft 365 and Gmail simultaneously. Read actions default to your primary mailbox; write actions require specifying a mailbox when multiple are configured.

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
