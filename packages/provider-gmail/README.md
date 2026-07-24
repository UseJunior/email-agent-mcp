# @usejunior/provider-gmail

Gmail setup for `email-agent-mcp`.

## Status

The Gmail provider supports read/search/thread/draft/send flows through the MCP server. First-time setup goes through a hosted OAuth broker so users do not have to register their own Google Cloud project. Power users can still bring their own OAuth client.

## 1. Run the interactive CLI flow

```bash
npx tsx packages/email-mcp/src/cli.ts configure \
  --provider gmail \
  --mailbox personal
```

That opens Google's consent screen via the hosted broker (`https://oauth.usejunior.com` by default). The broker holds the OAuth `client_secret` server-side, completes the code exchange, and hands the resulting tokens back to the CLI. **Email content never touches the broker** — Gmail API calls go directly from your machine to Google with the locally-held access token.

To point at a self-hosted broker (for example, your own Vercel deployment of `apps/oauth-broker`), set:

```bash
npx tsx packages/email-mcp/src/cli.ts configure \
  --provider gmail \
  --mailbox personal \
  --broker-url https://my-broker.example.com
```

Or `export AGENT_EMAIL_GMAIL_BROKER_URL=https://my-broker.example.com`.

## 2. Bring-your-own-key (BYOK) path

If you want to authenticate against your own Google OAuth client (dedicated quota, your privacy policy, your verification status), pass both halves of the credentials:

```bash
npx tsx packages/email-mcp/src/cli.ts configure \
  --provider gmail \
  --mailbox personal \
  --client-id YOUR_GOOGLE_CLIENT_ID \
  --client-secret YOUR_GOOGLE_CLIENT_SECRET
```

Or via env vars:

```bash
export AGENT_EMAIL_GMAIL_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
export AGENT_EMAIL_GMAIL_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET
npx tsx packages/email-mcp/src/cli.ts configure --provider gmail --mailbox personal
```

To create the client in Google Cloud Console:

1. Enable the Gmail API for your project.
2. Create an OAuth client ID of type "Desktop app".
3. Record the `client_id` and `client_secret`.

The BYOK path runs the full local-loopback OAuth dance (`http://127.0.0.1`); no broker is involved.

The CLI saves mailbox metadata under `~/.email-agent-mcp/tokens/` and auto-adds the authenticated address to `send-allowlist.json`. Saved metadata is **never** rewritten with a different OAuth client on subsequent runs — re-running `configure` for an existing mailbox reuses whatever was saved (broker URL or BYOK credentials).

## Disconnect and revoke

Stop the MCP process, then use Finder to move only the intended mailbox's JSON
file from `~/.email-agent-mcp/tokens/` to Trash. If
`EMAIL_AGENT_MCP_HOME` is set, use its `tokens/` directory instead. Never open
or share the token file, and preserve other mailbox files.

Then visit [Google Account third-party
connections](https://myaccount.google.com/connections), select Email Agent MCP
(or your BYOK app name), and remove access. Local removal prevents this
installation from loading the saved credential; Google Account revocation
invalidates the grant itself.

## 3. Manual refresh-token path

The simplest path is Google's OAuth 2.0 Playground using your own client credentials.

1. Open `https://developers.google.com/oauthplayground/`.
2. Click the gear icon and enable "Use your own OAuth credentials".
3. Paste your Google `client_id` and `client_secret`.
4. Authorize the Gmail scope
   `https://www.googleapis.com/auth/gmail.modify`.
5. Exchange the authorization code for tokens.
6. Copy the returned `refresh_token`.

`email-agent-mcp` only needs the refresh token on disk. Access tokens are refreshed automatically — through the broker for broker-mode mailboxes, directly via `google-auth-library` for BYOK mailboxes.

## 4. Write the mailbox metadata file

Create `~/.email-agent-mcp/tokens/<safe-key>.json`, where `<safe-key>` is the lowercased email address with `@` replaced by `-at-`, `.` replaced by `-`, and other non-alphanumerics stripped.

Example for `steven.obiajulu@gmail.com`:

Path:

```text
~/.email-agent-mcp/tokens/steven-obiajulu-at-gmail-com.json
```

BYOK contents:

```json
{
  "provider": "gmail",
  "source": "byok",
  "mailboxName": "personal",
  "emailAddress": "steven.obiajulu@gmail.com",
  "clientId": "YOUR_GOOGLE_CLIENT_ID",
  "clientSecret": "YOUR_GOOGLE_CLIENT_SECRET",
  "refreshToken": "YOUR_GOOGLE_REFRESH_TOKEN",
  "lastInteractiveAuthAt": "2026-04-08T12:00:00.000Z"
}
```

Broker contents (no `clientSecret` on disk — refreshes go through the broker):

```json
{
  "provider": "gmail",
  "source": "broker",
  "mailboxName": "personal",
  "emailAddress": "steven.obiajulu@gmail.com",
  "brokerUrl": "https://oauth.usejunior.com",
  "refreshToken": "YOUR_GOOGLE_REFRESH_TOKEN",
  "lastInteractiveAuthAt": "2026-04-08T12:00:00.000Z"
}
```

`mailboxName` is an alias. `emailAddress` is the canonical mailbox identity.

## 5. Start the server

```bash
npx tsx packages/email-mcp/src/cli.ts serve
```

Then call `get_mailbox_status`, `list_emails`, `read_email`, or `search_emails`.

## Search example

To search for an older driver's license email, start with Gmail's native query syntax via `search_emails`:

```json
{
  "query": "\"driver license\" OR \"driver's license\" OR license has:attachment",
  "limit": 25
}
```

Then widen or narrow with Gmail filters such as `older_than:5y`, `from:dmv`, `filename:pdf`, or `in:anywhere`.

## Outbound attachments

`create_draft`, `update_draft`, `send_email`, and `reply_to_email` accept an
`attachments` array. Each entry is either a sandboxed file `path` or inline
`base64`, with optional `filename` / `mimeType` overrides. Gmail builds a
`multipart/mixed` MIME message; the 25MB per-file cap is enforced before send.

## Current caveats

- Gmail watcher / PubSub wiring is not implemented yet.
- Inline (CID) image attachments on outgoing mail are not implemented yet.
