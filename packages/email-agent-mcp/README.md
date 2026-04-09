# Agent Email

[![npm version](https://img.shields.io/npm/v/email-agent-mcp)](https://www.npmjs.com/package/email-agent-mcp)
[![npm downloads](https://img.shields.io/npm/dm/email-agent-mcp.svg)](https://npmjs.org/package/email-agent-mcp)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/UseJunior/email-agent-mcp/actions/workflows/ci.yml)
[![codecov](https://img.shields.io/codecov/c/github/UseJunior/email-agent-mcp/main)](https://app.codecov.io/gh/UseJunior/email-agent-mcp)
[![GitHub stargazers](https://img.shields.io/github/stars/UseJunior/email-agent-mcp?style=social)](https://github.com/UseJunior/email-agent-mcp/stargazers)
[![Socket Badge](https://socket.dev/api/badge/npm/package/email-agent-mcp)](https://socket.dev/npm/package/email-agent-mcp)
[![install size](https://img.shields.io/npm/unpacked-size/email-agent-mcp)](https://www.npmjs.com/package/email-agent-mcp)

[Repo README](https://github.com/UseJunior/email-agent-mcp/blob/main/README.md) | [Español](https://github.com/UseJunior/email-agent-mcp/blob/main/README.es.md) | [简体中文](https://github.com/UseJunior/email-agent-mcp/blob/main/README.zh.md) | [Português (Brasil)](https://github.com/UseJunior/email-agent-mcp/blob/main/README.pt-br.md) | [Deutsch](https://github.com/UseJunior/email-agent-mcp/blob/main/README.de.md)

**email-agent-mcp** by [UseJunior](https://usejunior.com) -- local email connectivity for AI agents.

Agent Email is an open-source TypeScript MCP server that lets Claude Code, Cursor, Gemini CLI, OpenClaw, and other MCP-compatible runtimes read email, search threads, draft replies, label messages, change read state, move messages, and send mail through your own mailbox. Microsoft 365 / Outlook and Gmail are supported today.

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

## Security Defaults

- **Send allowlist**: empty by default -- agents cannot send email until you add recipients
- **Receive allowlist**: accepts all by default -- controls which senders trigger the watcher
- **Delete disabled**: agents cannot delete email unless you set `user_explicitly_requested_deletion: true`
- **Error sanitization**: API keys, file paths, and stack traces are redacted from error responses
- **Body file sandboxing**: no `../` traversal, no symlinks, binary detection

## More

- [Repository README](https://github.com/UseJunior/email-agent-mcp/blob/main/README.md)
- [Contributing Guide](https://github.com/UseJunior/email-agent-mcp/blob/main/CONTRIBUTING.md)
- [Security Policy](https://github.com/UseJunior/email-agent-mcp/blob/main/SECURITY.md)
