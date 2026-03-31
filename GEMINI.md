# Agent Email -- Gemini CLI Extension

This extension provides email connectivity for AI agents via one local MCP server.

## MCP Server

| Server         | Package                     |
| -------------- | --------------------------- |
| `email-agent-mcp`  | `@usejunior/email-agent-mcp`    |

## Tool Inventory

### Reading

| Tool                 | Description                                      |
| -------------------- | ------------------------------------------------ |
| `list_emails`        | List emails in a mailbox folder                  |
| `read_email`         | Get full content of a single email               |
| `search_emails`      | Search emails by query string                    |
| `get_mailbox_status` | Check connection status and mailbox warnings     |
| `get_thread`         | Retrieve an entire conversation thread           |

### Sending

| Tool              | Description                              |
| ----------------- | ---------------------------------------- |
| `send_email`      | Compose and send a new email             |
| `reply_to_email`  | Reply to an existing email               |

### Drafts

| Tool            | Description                              |
| --------------- | ---------------------------------------- |
| `create_draft`  | Create a new draft message               |
| `update_draft`  | Update an existing draft                 |
| `send_draft`    | Send a previously saved draft            |

### Organization

| Tool             | Description                              |
| ---------------- | ---------------------------------------- |
| `label_email`    | Apply a label or category to an email    |
| `flag_email`     | Flag or unflag an email                  |
| `mark_read`      | Mark an email as read or unread          |
| `move_to_folder` | Move an email to a different folder      |

### Destructive

| Tool           | Description                                          |
| -------------- | ---------------------------------------------------- |
| `delete_email` | Permanently delete an email (requires explicit opt-in) |

## Trust Boundary

- The server runs locally via stdio. No network listener is exposed.
- OAuth tokens are stored in the OS keychain (MSAL) or in `~/.email-agent-mcp/`.
- No inbound ports are opened; all Microsoft Graph and Gmail API calls are outbound HTTPS.
- A send allowlist gates all outbound email. The allowlist is empty by default, meaning no email can be sent until the user explicitly configures permitted recipients.

## Recommended Workflow

1. **`get_mailbox_status`** -- Check that the connection is healthy and review any warnings.
2. **`list_emails`** or **`search_emails`** -- Find relevant messages in the mailbox.
3. **`read_email`** -- Get the full content of a message (HTML is converted to markdown).
4. **`reply_to_email`** or **`send_email`** -- Send outbound email (gated by the send allowlist).

## First-Time Setup

Run the following command to start interactive OAuth configuration:

```
npx @usejunior/email-agent-mcp
```

This will walk you through connecting a Microsoft 365 or Gmail account and storing credentials securely.
