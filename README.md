# Agent Email

[![CI](https://github.com/UseJunior/agent-email/actions/workflows/ci.yml/badge.svg)](https://github.com/UseJunior/agent-email/actions/workflows/ci.yml)
[![codecov](https://img.shields.io/codecov/c/github/UseJunior/agent-email/main)](https://app.codecov.io/gh/UseJunior/agent-email)

**agent-email** by [UseJunior](https://usejunior.com) — email connectivity for AI agents.

Part of the [UseJunior developer tools](https://usejunior.com/developer-tools/agent-email).

Agent Email is an open-source TypeScript MCP server that gives AI agents secure access to email. It exposes email operations via [Model Context Protocol](https://modelcontextprotocol.io/) for any MCP-compatible agent runtime — Claude Code, Gemini CLI, Cursor, Goose, and more. Security-first defaults mean agents cannot send email until you explicitly configure an allowlist.

## Why This Exists

AI agents need to read, reply to, and act on email, but email APIs are complex. OAuth flows, Graph delta queries, Gmail push subscriptions, HTML-to-markdown conversion, threading semantics — each provider has its own quirks.

Agent Email wraps this complexity into deterministic MCP tools with security guardrails:

- send and receive allowlists that control who agents can contact
- delete disabled by default (requires explicit opt-in)
- error sanitization that strips API keys, file paths, and stack traces
- body file sandboxing with path traversal protection

## Positioning

Agent Email is optimized for agent workflows that need secure, auditable email access:

- typed MCP tools for reading, sending, replying, drafting, categorizing, and managing email
- multi-mailbox support for working across accounts simultaneously
- watcher mode for push-style email notifications to agent runtimes

Agent Email is not a general-purpose email client library, a bulk sending tool, or a marketing automation platform.

## Provider Support

| Provider | Status | Package |
|----------|--------|---------|
| Microsoft 365 (Graph API) | Fully supported | `@usejunior/provider-microsoft` |
| Gmail | Coming soon | `@usejunior/provider-gmail` |

The Gmail provider package exists with full test coverage. Wiring into the MCP server is in progress.

## Start Here

```bash
npx -y @usejunior/agent-email
```

The interactive setup wizard walks you through OAuth configuration and mailbox selection.

## What Agent Email Is Optimized For

- **List** emails with filters (unread, sender, date range, folder)
- **Read** full email bodies with HTML-to-markdown conversion
- **Search** across mailboxes with full-text queries
- **Send** new emails (gated by send allowlist)
- **Reply** to threads with proper RFC threading (In-Reply-To, References)
- **Draft** lifecycle (create, update, send)
- **Label** and categorize emails
- **Flag** and mark emails as read/unread
- **Move** emails between folders
- **Delete** emails (requires explicit configuration)
- **Get threads** for full conversation context
- **Attachments** download and metadata
- **Watch** for new emails with delta-query polling
- **Configure** mailboxes and security policies

## What Agent Email Is Not Optimized For

Agent Email is not a full email client, a bulk sending tool, or a marketing automation platform.

If your primary need is transactional email or marketing, use services such as [SendGrid](https://sendgrid.com/) or [Resend](https://resend.com/).

## Packages

| Package | Description |
|---------|-------------|
| `@usejunior/email-core` | Core email actions, content engine, security, and provider interfaces |
| `@usejunior/email-mcp` | MCP server adapter, CLI, and watcher |
| `@usejunior/provider-microsoft` | Microsoft Graph API email provider |
| `@usejunior/provider-gmail` | Gmail API email provider |
| `@usejunior/agent-email` | Distribution wrapper (`npx @usejunior/agent-email`) |

## Security Defaults

Agent Email ships with restrictive defaults that you loosen as needed:

- **Send allowlist**: empty by default — agents cannot send email until you add recipients
- **Receive allowlist**: accepts all by default — controls which senders trigger the watcher
- **Delete disabled**: agents cannot delete email unless you set `user_explicitly_requested_deletion: true`
- **Error sanitization**: API keys, file paths, and stack traces are redacted from error responses
- **Body file sandboxing**: no `../` traversal, no symlinks, binary detection

## FAQ

### Does this work with Claude Code?

Yes. Run `npx @usejunior/agent-email` to start the MCP server, then configure it in your Claude Code settings.

### Can agents send email without my permission?

No. The send allowlist is empty by default. Agents cannot send any email until you explicitly configure allowed recipients.

### Does this store my email credentials?

OAuth tokens are managed by MSAL (Microsoft) and stored in your OS keychain or local config files under `~/.agent-email/`. Agent Email never stores raw passwords.

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

- [Safe DOCX Suite](https://github.com/UseJunior/safe-docx) — surgical editing of Word documents with coding agents
- [Open Agreements](https://github.com/open-agreements/open-agreements) — fill standard legal templates with coding agents

## Privacy

Agent Email runs entirely on your local machine. Email credentials are stored in your OS keychain (MSAL) and local config files. No email content is sent to external servers by Agent Email itself.

## Governance

- [Contributing Guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
