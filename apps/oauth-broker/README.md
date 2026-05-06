# email-agent-mcp OAuth broker

Vercel app that holds the Gmail OAuth `client_secret` server-side so the
CLI never has to. The CLI talks to this broker only at auth and refresh;
all Gmail API calls go directly from the user's machine to Google with
the locally-held access token.

This is the same trust model as commercial AI email clients (Superhuman,
Jace, Shortwave) — the secret stays on a server you control — without
the data-residency cost: **email content never touches the broker**.

## Routes

| Route | Purpose |
|---|---|
| `GET /api/start?session=<id>&login_hint=<email>` | Redirect to Google's consent screen with `state=<id>`. |
| `GET /api/callback?code=...&state=<id>` | Google redirect target. Exchanges code for tokens, parks them under `<id>`, shows a "return to terminal" page. |
| `GET /api/tickets/:id` | One-shot pickup. Returns tokens once and deletes them; returns 404 (`pending`) until the callback has fired. |
| `POST /api/refresh` `{ refresh_token }` | Refresh-token relay. Returns the new access_token. Stateless — broker never persists refresh tokens. |

## Why a session-ID-as-bearer instead of cookies

The CLI generates the session ID locally from 256 bits of CSPRNG entropy
and treats it as the bearer credential for the eventual ticket pickup.
The broker only sees the ID after the CLI has put it on the auth URL —
so even if our access logs leaked, an attacker couldn't pick up a ticket
they didn't issue. The ID also doubles as the OAuth `state` parameter,
giving CSRF protection for free.

## Deploying

1. Register a Web-app OAuth client in Google Cloud Console. Authorized
   redirect URI: `https://<your-broker-domain>/api/callback`.
2. `vercel link` this directory.
3. Set required env vars in the Vercel project:

   ```
   GMAIL_OAUTH_CLIENT_ID=<from Cloud Console>
   GMAIL_OAUTH_CLIENT_SECRET=<from Cloud Console>
   BROKER_PUBLIC_ORIGIN=https://<your-broker-domain>
   ```

4. Optional:

   ```
   GMAIL_OAUTH_SCOPES=https://mail.google.com/    # default
   BROKER_TICKET_TTL_MS=300000                    # 5 min, default
   ```

5. Provision Vercel KV for the ticket store (recommended — required if
   the function runs on more than one instance). The store auto-detects
   `KV_REST_API_URL`. With KV unset, the broker falls back to in-memory,
   which is fine for `vercel dev` but breaks under multi-instance prod.

6. `vercel --prod`.

## Verification

`https://<your-broker-domain>` must complete Google's OAuth verification
flow including **CASA Tier 2** for the restricted `https://mail.google.com/`
scope. CASA is required regardless of whether you ship a bundled secret
or run a broker.

## Self-hosting

Users who don't want to depend on the official broker can clone this
directory, register their own Google OAuth client, deploy to their own
Vercel project, and pass `--broker-url=https://my-broker.example.com`
to `email-agent-mcp configure --provider gmail`. The CLI's BYOK path
(`--client-id` + `--client-secret`) also remains available for users
who'd rather skip a broker entirely.

## What this broker does NOT do

- Store refresh tokens.
- Read or proxy email content.
- Authenticate users (we only relay OAuth).
- Bind tokens to identities. The session ID is the only credential.
