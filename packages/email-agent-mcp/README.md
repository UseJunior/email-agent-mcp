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

`email-agent-mcp` is the canonical package name. The legacy
`@usejunior/email-agent-mcp` compatibility package is published in lockstep for
existing users, but new installations should use the unscoped package shown
above.

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

Agent Email exposes 26 MCP tools:

| Tool | Description | Type |
|------|-------------|------|
| `list_emails` | List recent emails with filtering | read |
| `read_email` | Read full email content as markdown | read |
| `search_emails` | Full-text search across mailboxes | read |
| `list_mailboxes` | Enumerate configured mailboxes, status, and default | read |
| `get_mailbox_status` | Connection status and warnings | read |
| `get_thread` | Full conversation context | read |
| `list_attachments` | List attachment metadata for an email | read |
| `download_attachment` | Download a file attachment as base64 | read |
| `send_email` | Send new email (allowlist-gated) | write |
| `reply_to_email` | Reply with RFC threading | write |
| `create_draft` | Create email draft | write |
| `update_draft` | Update draft content | write |
| `send_draft` | Send a saved draft | write |
| `list_scheduled_sends` | List pending provider-held scheduled sends (Microsoft 365) | read |
| `cancel_scheduled_send` | Cancel a pending scheduled send (Microsoft 365) | destructive |
| `label_email` | Apply labels/categories | write |
| `flag_email` | Flag/unflag emails | write |
| `mark_read` | Mark as read/unread | write |
| `move_to_folder` | Move between folders | write |
| `delete_email` | Delete (requires operator env + caller flag) | destructive |
| `list_folders` | List Microsoft 365 mail folders | read |
| `create_folder` | Create a Microsoft 365 custom folder | write |
| `delete_folder` | Delete a Microsoft 365 custom folder | destructive |
| `list_inbox_rules` | List Microsoft 365 inbox rules | read |
| `create_inbox_rule` | Create a safe Microsoft 365 inbox rule | write |
| `delete_inbox_rule` | Delete a Microsoft 365 inbox rule | destructive |

`send_email` and `send_draft` accept an optional `scheduled_send_at` ISO 8601
future timestamp with an explicit timezone. Microsoft 365 holds scheduled
messages server-side. The returned `messageId` can be listed or cancelled while
pending, but changes after delivery when Graph moves the item to Sent Items.
Gmail scheduled send is `NOT_SUPPORTED` because the public Gmail API exposes no
equivalent operation.

`send_email`, `reply_to_email`, `create_draft`, and `update_draft` accept an
optional `attachments` array — each entry is a sandboxed file `path` or inline
`base64`, with optional `filename` / `mimeType`. Files are capped at 25MB each.

## Provider Support

| Provider | Status | Package |
|----------|--------|---------|
| Microsoft 365 (Graph API) | Fully supported | `@usejunior/provider-microsoft` |
| Gmail | Supported via interactive CLI OAuth or manual refresh-token setup | `@usejunior/provider-gmail` |

## Security Defaults

- **Send allowlist**: empty by default -- agents cannot send email until you add recipients
- **Receive allowlist**: accepts all by default -- controls which senders trigger the watcher
- **Delete disabled**: agents cannot delete email by default. Two gates must both be satisfied: (1) operator sets `AGENT_EMAIL_DELETE_ENABLED=true` in the email-agent-mcp process environment (and `AGENT_EMAIL_HARD_DELETE_ENABLED=true` for permanent deletion; restart required), and (2) the caller passes `user_explicitly_requested_deletion: true` on the tool call.
- **Error sanitization**: API keys, file paths, and stack traces are redacted from error responses
- **Body file sandboxing**: no `../` traversal, no symlinks, binary detection

## More

- [Repository README](https://github.com/UseJunior/email-agent-mcp/blob/main/README.md)
- [Contributing Guide](https://github.com/UseJunior/email-agent-mcp/blob/main/CONTRIBUTING.md)
- [Security Policy](https://github.com/UseJunior/email-agent-mcp/blob/main/SECURITY.md)
