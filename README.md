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

**email-agent-mcp** by [UseJunior](https://usejunior.com?utm_source=github&utm_medium=readme&utm_campaign=email-agent-mcp) -- local email connectivity for AI agents.

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

### Scope profiles

Set `EMAIL_AGENT_MCP_SCOPE_PROFILE` before configuring and starting the server to
choose the permissions exposed to an agent. The default is `full` for backward
compatibility.

| Profile | Microsoft delegated scopes | Exposed tools |
|---------|-----------------------------|---------------|
| `observe` | `Mail.Read`, `MailboxSettings.Read`, `User.Read`, `offline_access` | Read-only email tools plus local mailbox configuration/authentication tools |
| `full` (default) | `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`, `User.Read`, `offline_access` | All tools |

For an observation-only deployment, set the profile for both configuration and
runtime so the OAuth consent and MCP tool list agree:

```bash
export EMAIL_AGENT_MCP_SCOPE_PROFILE=observe
npx email-agent-mcp configure
npx email-agent-mcp serve
```

Changing profiles changes the Microsoft OAuth scope set. MSAL caches tokens by
scope, so restart the server and run `email-agent-mcp configure` again to grant
the new scopes. In particular, switching from `observe` to `full` requires a new
interactive consent before write tools can be used. An invalid profile value
stops startup instead of silently granting broader access.

### Tools

The `full` profile exposes 26 MCP tools; `observe` omits every tool whose action
is marked as mailbox-mutating:

| Tool | Description | Type |
|------|-------------|------|
| `list_emails` | List recent emails with filtering | read |
| `read_email` | Read full email content as markdown, or raw HTML with `format: "html"` | read |
| `search_emails` | Full-text search across mailboxes | read |
| `list_mailboxes` | Enumerate configured mailboxes, their status, and the default | read |
| `get_mailbox_status` | Connection status and warnings | read |
| `get_thread` | Full conversation context | read |
| `list_attachments` | List attachment metadata for an email | read |
| `download_attachment` | Download a file attachment as base64 | read |
| `send_email` | Send new email (allowlist-gated) | write |
| `reply_to_email` | Reply within thread (allowlist-gated on send) | write |
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
| `list_folders` | Recursively list folders and computed paths (Microsoft 365) | read |
| `create_folder` | Create a custom child folder (Microsoft 365) | write |
| `delete_folder` | Delete a custom folder (requires operator env + caller flag); system folders are protected (Microsoft 365) | destructive |
| `list_inbox_rules` | List server-side inbox rules (Microsoft 365) | read |
| `create_inbox_rule` | Create a persistent safe inbox rule; forwarding, redirection, deletion, and discarding to Deleted Items are blocked (Microsoft 365) | write |
| `delete_inbox_rule` | Delete a server-side inbox rule (requires operator env + caller flag) (Microsoft 365) | destructive |

Every row returned by `list_emails`, `search_emails`, and `get_thread`, and the
`read_email` response, carries an always-present `isDraft` boolean. `isDraft: true`
means the message is an unsent draft: it has **not** been sent, and its `receivedAt`
is provider-supplied metadata rather than evidence of delivery. The field is never
omitted, so a consuming agent can distinguish "not a draft" from "draft status not
reported" — but note `false` asserts only that the provider did not mark the message
as an unsent draft, not that the mailbox owner sent it (received mail is also
`false`). Drafts otherwise appear in listings and search results as before.

Folder and inbox-rule management requires Microsoft Graph `MailboxSettings.ReadWrite` consent. Existing Microsoft mailbox connections must re-consent after upgrading. Gmail uses labels rather than hierarchical folders/server-side Exchange rules, so these six tools return `NOT_SUPPORTED` for Gmail mailboxes.

### Body formats

Bodies cross the wire as markdown by default in both directions. That default is
deliberate — markdown is token-efficient, and a routine read should stay cheap.
Both directions can opt out of it.

**Writing** — `send_email`, `reply_to_email`, `create_draft`, and `update_draft`
accept an optional `format`:

| `format` | Behavior |
|----------|----------|
| `markdown` (default) | Rendered to HTML via `marked` (GFM, `breaks: true`). Raw HTML embedded in the markdown is preserved. |
| `html` | Passthrough — your HTML is sent as-is. |
| `text` | No rendering; sent as plain text. |

`html` is unsanitised passthrough: no sanitiser, no allowlist, no rewriting of
your markup. Inline CSS and arbitrary tags survive to the wire — that is what
makes styled mail possible, and it means you own whatever you send. The one
default modification is the force-black wrapper below; with `force_black:
false` the body passes through byte-for-byte.

For `markdown` and `html` the rendered HTML is wrapped in a
`<div style="color: #000000;">` so Outlook's dark mode does not turn the text
white-on-white.

**Body files** — `send_email`, `create_draft`, and `update_draft` also accept
`body_file`: a path to a `.md`, `.html`, or `.txt` file (read relative to
`EMAIL_MCP_SAFE_DIR`, default the process working directory) used as the body
instead of `body`. A `.md` body file may
open with a YAML frontmatter block:

For `update_draft`, `body` and `body_file` are permitted only on a non-reply
draft and require `replace_body: true`; the stored body is then replaced
wholesale. Reply draft bodies cannot be edited safely because they include
provider-assembled quoted history, so create a new draft instead. Subject,
recipient, and attachment updates remain available on reply drafts.

```md
---
to: alex@example.com
subject: Quarterly summary
format: html
force_black: false
---
<p>The body starts after the closing delimiter.</p>
```

Recognized keys are `to`, `cc`, `subject`, `reply_to`, `draft`, `format`, and
`force_black` (`draft: true` turns a `send_email` call into a draft save). A
frontmatter value overrides the same-named tool parameter. Frontmatter is
parsed only from `.md` files, and the file extension never selects the format —
without an explicit `format` tool parameter, even a `.html` body file gets the
default markdown rendering; pass `format: "html"` for passthrough.

**Reading** — `read_email` accepts an optional `format` of `markdown` (default)
or `html`:

```json
{ "id": "AAMkAD...", "format": "html" }
```

`format: "html"` returns the message's raw body HTML verbatim. Reach for it when
you need styling that markdown cannot carry — `color`, `background-color`,
`text-decoration`, `<u>` — for example to change one sentence of a formatted body
and leave the rest alone. Through the markdown path that styling is silently
destroyed on the way out.

Two fields come back with it:

- `bodyFormat` — always present: `markdown`, `html`, or `text`. You get `text`
  when you asked for `html` but the message has no HTML part, in which case the
  plain-text body is returned. Check this before writing a body back.
- `bodyTruncated` — present and `true` only if the body exceeded the 256 KB
  response budget for `format: "html"` (the markdown path is unbounded, as
  before). Do not write a truncated body back to a draft.

Raw HTML costs far more tokens than its markdown reduction, so leave the default
alone unless you need the styling. `strip_quoted_history` and `strip_signatures`
are markdown-shaped text transforms and are not applied when `format` is `html` —
the raw HTML is returned untouched.

**Writing it back.** Pass `format: "html"` **and `force_black: false`**:

```json
{ "draft_id": "AAMkAD...", "body": "<edited html>", "format": "html", "force_black": false }
```

`force_black` defaults to `true`, which wraps whatever HTML you send in a
`<div style="color: #000000;">`. That is right for HTML you authored yourself,
but on a body you just read back it nests one more wrapper on every cycle — after
fifteen revisions you have fifteen nested divs. With `force_black: false` the
bytes survive the round trip untouched.

### Scheduled send

`send_email` and `send_draft` accept `scheduled_send_at`, an ISO 8601 future
timestamp with an explicit timezone. Microsoft 365 holds the message
server-side, so delivery survives this process exiting. Use the returned
`messageId` with `cancel_scheduled_send` while it is pending, or inspect pending
items with `list_scheduled_sends`.

Microsoft Graph changes the message ID when the held draft moves to Sent Items,
so the returned ID is a pre-delivery management handle, not a permanent sent
message ID. Gmail's public API does not expose scheduled send; all scheduled
send surfaces return `NOT_SUPPORTED` for Gmail while immediate sends remain
unchanged.

### Outbound attachments

`send_email`, `reply_to_email`, `create_draft`, and `update_draft` accept an
optional `attachments` array. Each entry takes a sandboxed file `path` (read
relative to `EMAIL_MCP_SAFE_DIR`, default the process working directory) or
inline `base64`, plus optional `filename` / `mimeType` overrides:

```json
{
  "to": "alice@example.com",
  "subject": "Signed agreement",
  "body": "Attached as requested.",
  "attachments": [
    { "path": "./out/agreement.pdf" },
    { "base64": "iVBORw0KGgo...", "filename": "screenshot.png" }
  ]
}
```

Files are capped at 25MB each; Microsoft Graph additionally caps inline sends
at ~3MB total (larger files need an upload session — not yet supported). For
`update_draft`, omitting `attachments` preserves the draft's existing files;
passing an array (even empty) replaces them.

## Provider Support

| Provider | Status | Package |
|----------|--------|---------|
| Microsoft 365 (Graph API) | Fully supported | `@usejunior/provider-microsoft` |
| Gmail | Supported via interactive CLI OAuth (default client or your own) or manual refresh-token setup | `@usejunior/provider-gmail` |

Use `email-agent-mcp configure --provider gmail` to run the local browser OAuth flow, or add a manual mailbox token file under `~/.email-agent-mcp/tokens/`. See [Gmail Setup](#gmail-setup) below and [packages/provider-gmail/README.md](./packages/provider-gmail/README.md).

## Gmail Setup

Gmail has two supported OAuth paths. Both end with the same result: a refresh
token on your machine, and Gmail API calls going directly from your machine to
Google.

| Path | Command | Google Cloud project needed? |
|------|---------|------------------------------|
| Default OAuth client | `email-agent-mcp configure --provider gmail` | No |
| Bring your own key (BYOK) | same command plus `--client-id` / `--client-secret` | Yes, yours |

**Recommended for now: BYOK.** Our default OAuth client is still in Google's
"Testing" publishing status while verification is in progress, which caps it at
100 registered test users and shows the "Google hasn't verified this app"
interstitial during consent. Verification for Gmail's restricted scope requires
a CASA security assessment and takes several weeks; progress is tracked in
[issue #112](https://github.com/UseJunior/email-agent-mcp/issues/112). BYOK
sidesteps the shared 100-user cap and puts the app's publishing status under
your control; your own app still has Google's Testing constraints until you
publish it.

Other reasons to pick BYOK: dedicated API quota, your own privacy policy and
verification status, and no dependency on the hosted broker at
`https://oauth.usejunior.com`.

### Scope requested

Agent Email requests exactly one Gmail scope:

```text
https://www.googleapis.com/auth/gmail.modify
```

This is the narrowest Gmail scope that covers Agent Email's read, compose,
send, label, and soft-delete-to-trash behavior. It does not permit immediate,
permanent deletion. It is the single scope you add to your own OAuth consent
screen.

### BYOK: create your own Google OAuth client

1. **Create a project** in the [Google Cloud Console](https://console.cloud.google.com/projectcreate),
   or select an existing one.
2. **Enable the Gmail API** under *APIs & Services → Library → Gmail API → Enable*.
3. **Configure the OAuth consent screen** under *APIs & Services → OAuth consent screen*:
   - User type **External** for a personal `@gmail.com` account, or **Internal**
     if you are on Google Workspace and only your own org needs access.
   - Add the scope `https://www.googleapis.com/auth/gmail.modify`.
   - While the app is in *Testing*, add your own Gmail address under **Test users**,
     or consent will be refused.
4. **Create the OAuth client** under *APIs & Services → Credentials → Create
   credentials → OAuth client ID*. Choose application type **Desktop app**.
   Desktop is required: `configure` starts a throwaway listener on an ephemeral
   loopback port (`http://127.0.0.1:<port>/oauth2callback`), and only Desktop
   clients let Google accept an arbitrary loopback port without pre-registering
   the exact redirect URI. A Web application client will fail with
   `redirect_uri_mismatch`.
5. **Copy the client ID and client secret.**

### BYOK: hand the credentials to email-agent-mcp

Pass both halves as flags:

```bash
npx email-agent-mcp configure \
  --provider gmail \
  --mailbox personal \
  --client-id YOUR_GOOGLE_CLIENT_ID \
  --client-secret YOUR_GOOGLE_CLIENT_SECRET
```

Or set the two namespaced environment variables and omit the flags:

```bash
export AGENT_EMAIL_GMAIL_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
export AGENT_EMAIL_GMAIL_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET

npx email-agent-mcp configure --provider gmail --mailbox personal
```

Both halves are required. Supplying only one exits with an error rather than
silently falling back to the default client. Supplying neither selects the
default OAuth client.

Your browser opens Google's consent screen, the CLI catches the callback on
loopback, exchanges the code with PKCE, and writes the mailbox to
`~/.email-agent-mcp/tokens/<safe-key>.json` with `"source": "byok"` alongside
your `clientId`, `clientSecret`, and the resulting `refreshToken`. Token
refreshes then go straight to Google's token endpoint; no broker is involved.

Re-running `configure` for a mailbox that is already saved reuses the saved
credentials, so you only pass the flags once. Passing `--client-id` and
`--client-secret` for a mailbox previously configured against the default
client migrates it to BYOK.

### BYOK: keep the grant from expiring after 7 days

Google expires refresh tokens after 7 days while *your* OAuth app is in
*Testing* publishing status, which shows up as a re-authentication prompt about
once a week. `email-agent-mcp status` warns when a mailbox is approaching that
window. Publishing your app (*OAuth consent screen → Publish app*) removes the
7-day expiry. Since you own the app and are its only user, the 100-user test
cap does not apply to you either way.

### Disconnect Gmail and revoke access

Disconnecting has two independent parts:

1. Stop any running `email-agent-mcp` process. In Finder, open
   `~/.email-agent-mcp/tokens/`, identify the single JSON file for the mailbox
   you intend to disconnect, and move that exact file to Trash. Do not open,
   paste, or share its contents, and do not delete the whole
   `~/.email-agent-mcp` directory if other mailboxes are configured. If you
   set `EMAIL_AGENT_MCP_HOME`, use that directory's `tokens/` folder instead.
2. Open [Google Account third-party
   connections](https://myaccount.google.com/connections), select Email Agent
   MCP (or the name of your BYOK application), and remove its access.

Deleting the local file prevents this installation from using the saved
credential. Removing the Google Account connection revokes the grant at
Google. Run `email-agent-mcp status` afterward to confirm the mailbox is no
longer configured.

## Security Defaults

Agent Email ships with restrictive defaults that you loosen as needed:

- **Send allowlist**: empty by default -- agents cannot send email until you add recipients
- **Receive allowlist**: accepts all by default -- controls which senders trigger the watcher
- **Delete disabled**: agents cannot delete email by default. Two gates must both be satisfied:
  1. operator sets `AGENT_EMAIL_DELETE_ENABLED=true` in the email-agent-mcp process environment (and `AGENT_EMAIL_HARD_DELETE_ENABLED=true` for permanent deletion). Restart required after change.
  2. the caller passes `user_explicitly_requested_deletion: true` on the tool call.
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
| `@usejunior/email-agent-mcp` | Compatibility wrapper, published in lockstep; use `email-agent-mcp` for new installs |

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

Tag-driven release via GitHub Actions with npm OIDC trusted publishing. All 6 packages publish in dependency order with `--provenance`, then `server.json` is published to the official MCP Registry with `mcp-publisher`.

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
