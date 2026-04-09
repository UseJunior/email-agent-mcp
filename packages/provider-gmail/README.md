# @usejunior/provider-gmail

Gmail setup for `email-agent-mcp`.

## Status

The Gmail provider supports read/search/thread/draft/send flows through the MCP server. The recommended path is `email-agent-mcp configure --provider gmail`, which starts a local browser OAuth flow and writes the mailbox metadata for you. Manual token-file setup still works when you already have a refresh token.

## 1. Create Google OAuth credentials

Create an OAuth client in Google Cloud Console:

1. Enable the Gmail API for your project.
2. Create an OAuth client ID.
3. Use a desktop-app client if you want the simplest local flow.
4. Record the `client_id` and `client_secret`.

## 2. Run the interactive CLI flow

With your Google OAuth client ready, run:

```bash
npx tsx packages/email-mcp/src/cli.ts configure \
  --provider gmail \
  --mailbox personal \
  --client-id YOUR_GOOGLE_CLIENT_ID \
  --client-secret YOUR_GOOGLE_CLIENT_SECRET
```

You can also provide the OAuth client through environment variables:

```bash
export AGENT_EMAIL_GMAIL_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
export AGENT_EMAIL_GMAIL_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET
npx tsx packages/email-mcp/src/cli.ts configure --provider gmail --mailbox personal
```

The CLI prints a Google authorization URL, listens on a local `127.0.0.1` callback, saves the mailbox metadata under `~/.email-agent-mcp/tokens/`, and auto-adds the authenticated address to `send-allowlist.json`.

## 3. Manual refresh-token path

The simplest path is Google's OAuth 2.0 Playground using your own client credentials.

1. Open `https://developers.google.com/oauthplayground/`.
2. Click the gear icon and enable "Use your own OAuth credentials".
3. Paste your Google `client_id` and `client_secret`.
4. Authorize the Gmail scope `https://mail.google.com/`.
5. Exchange the authorization code for tokens.
6. Copy the returned `refresh_token`.

`email-agent-mcp` only needs the refresh token on disk. Access tokens are refreshed automatically by `google-auth-library`.

## 4. Write the mailbox metadata file

Create `~/.email-agent-mcp/tokens/<safe-key>.json`, where `<safe-key>` is the lowercased email address with `@` replaced by `-at-`, `.` replaced by `-`, and other non-alphanumerics stripped.

Example for `steven.obiajulu@gmail.com`:

Path:

```text
~/.email-agent-mcp/tokens/steven-obiajulu-at-gmail-com.json
```

Contents:

```json
{
  "provider": "gmail",
  "mailboxName": "personal",
  "emailAddress": "steven.obiajulu@gmail.com",
  "clientId": "YOUR_GOOGLE_CLIENT_ID",
  "clientSecret": "YOUR_GOOGLE_CLIENT_SECRET",
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

## Current caveats

- Gmail watcher / PubSub wiring is not implemented yet.
- Gmail attachments on outgoing mail are not implemented yet.
