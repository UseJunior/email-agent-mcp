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
| `POST /api/sessions` `{session_id, pickup_hash, login_hint?}` | Pre-register a session before opening the browser. `pickup_hash` is SHA-256 of a `pickup_secret` the CLI keeps locally; the secret itself never traverses the network. Returns 201 on create, 409 on collision. |
| `GET /api/start?session=<session_id>` | Browser entry point. Looks up the registered session, redirects to Google's consent screen with `state=<session_id>`. 410 if the session is missing/expired/already-advanced. |
| `GET /api/callback?code=...&state=<session_id>` | Google's redirect target. Exchanges the code for tokens (using the server-held `client_secret`), advances the session to `ready` (or `denied` / `exchange_failed`), shows the user a "return to terminal" page. |
| `POST /api/tickets/claim` `{session_id, pickup_secret}` | One-shot ticket pickup. Verifies SHA-256(`pickup_secret`) against the stored hash in constant time, then atomically deletes the session record (Redis `GETDEL` on KV) and returns the tokens. Distinguishable response statuses: 200 ready, 202 pending, 403 invalid_secret, 404 not_found, 410 + status (`denied` / `exchange_failed` / `expired` / `consumed`). |
| `POST /api/refresh` `{refresh_token}` | Stateless refresh-token relay. Returns the new access_token. Broker never persists refresh tokens. |

## Why session_id ≠ pickup_secret

The `session_id` is necessarily public — it lives in the browser URL,
Google's `state` parameter, and the broker's access logs. If the same
value were the credential for ticket pickup, anyone who saw the URL
could steal the tokens before the legitimate CLI claimed them.

The `pickup_secret` is generated locally by the CLI from 256 bits of
CSPRNG entropy and is **only** sent over the wire as the body of a
`POST /api/tickets/claim` request from the originating CLI. The broker
stores only its SHA-256 hash. Constant-time comparison defeats timing
attacks on the verification step.

## Atomic one-shot claim

On Redis-backed deployments, after the hash check succeeds the broker
calls `GETDEL session:<id>` — a single Redis command — which atomically
returns the tokens and removes the key. Two concurrent claims with the
correct secret therefore cannot both succeed: only one observes the
value, the other gets back `null` and surfaces 410 `consumed`.

The in-memory backend (used only for `vercel dev` and unit tests)
relies on Node's single-threaded execution model: `Map.get` followed
by `Map.delete` between awaits is effectively atomic.

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
   GMAIL_OAUTH_SCOPES=https://www.googleapis.com/auth/gmail.modify    # default
   BROKER_TICKET_TTL_MS=300000                    # 5 min, default
   BROKER_REQUIRE_KV=true                         # force-fail without Redis even outside prod
   ```

5. **Attach Redis** (Vercel Marketplace → Upstash, or Vercel-managed
   Redis). The store auto-detects `KV_REST_API_URL`. Production
   deployments **refuse to start** without it because Vercel Functions
   do not guarantee instance reuse — cross-request in-memory state is
   not actually shared. The in-memory fallback exists only for
   `vercel dev` and unit tests.

6. `vercel --prod`.

## Verification

`https://<your-broker-domain>` must complete Google's OAuth verification
flow for the restricted
`https://www.googleapis.com/auth/gmail.modify` scope. Per Google's
restricted-scope policy, transmitting restricted-scope data through a server
requires a security assessment; running a server in the auth path does not
remove that requirement.

If an existing deployment explicitly sets `GMAIL_OAUTH_SCOPES`, update the
environment value to `https://www.googleapis.com/auth/gmail.modify` before
submitting the OAuth app for verification.

For the audited project values, pre-submission gates, scope justification,
privacy-policy facts, and demo script, follow the
[Google OAuth verification runbook](./VERIFICATION.md).

## Operational notes (deferred to follow-up PRs)

- Rate limiting on `/api/start` and `/api/refresh` is not yet in place;
  Google's own quota is the only backstop. Add IP-based rate limiting
  via Vercel Edge Config or Upstash Ratelimit before promoting beyond
  alpha use.
- No abuse logging or alerting is wired. Add a structured logger that
  scrubs tokens.

## Self-hosting

Users who don't want to depend on the official broker can clone this
directory, register their own Google OAuth client, deploy to their own
Vercel project, and pass `--broker-url=https://my-broker.example.com`
to `email-agent-mcp configure --provider gmail`. The CLI's BYOK path
(`--client-id` + `--client-secret`) also remains available for users
who'd rather skip a broker entirely.

## What this broker does NOT do

- Store refresh tokens (only relays them in flight).
- Read or proxy email content.
- Authenticate users (we only relay OAuth).
- Bind tokens to identities. The `pickup_secret` is the only credential.
