## Why

Gmail users still need to provide a Google OAuth client ID and client secret before `email-agent-mcp configure --provider gmail` can open the browser consent flow. That creates unnecessary setup friction and makes Gmail feel materially harder to connect than Microsoft, even though both ultimately use OAuth.

We cannot remove that friction by bundling a default OAuth client_secret into the OSS CLI. A live probe of Google's token endpoint confirms the bundled Desktop client_id still requires `client_secret` for code exchange — even with PKCE — so any default-client design that ships the secret violates Google's OAuth policy ("never commit client credentials") with no compensating security benefit. Microsoft's path "just works" with `client_id` only because Entra ID supports public clients natively; Google does not offer an equivalent for a Node CLI.

The defensible way to remove the friction is the same pattern commercial AI email clients (Superhuman, Jace, Shortwave) use: a server-side OAuth client whose secret stays on the server. We adopt that pattern with a deliberate twist — the broker only relays the OAuth dance and refreshes; **email content never touches the broker**. The CLI continues to call Gmail directly with the locally-held access token.

## What Changes

- Add a Vercel-deployable OAuth broker app under `apps/oauth-broker` with five routes (`POST /api/sessions`, `GET /api/start`, `GET /api/callback`, `POST /api/tickets/claim`, `POST /api/refresh`) that hold the Gmail OAuth `client_id` + `client_secret` server-side and relay the dance.
- Split the public `session_id` (visible in URLs and Google's `state`) from a private `pickup_secret` only the CLI knows; the broker stores SHA-256 of the secret and verifies it in constant time at claim time. URL leakage alone cannot steal tokens.
- Track session state on the broker (`pending` | `ready` | `consumed` | `denied` | `exchange_failed` | `expired`) so the CLI can surface actionable errors instead of mistaking "user clicked deny" for "still pending".
- Use atomic Redis `GETDEL` (or single-threaded delete on the in-memory dev backend) for one-shot token claim — concurrent claims with the same correct secret cannot both succeed.
- Refuse to start in production without Redis attached (`KV_REST_API_URL` must be set when `VERCEL_ENV=production` or `BROKER_REQUIRE_KV=true`).
- Make broker mode the default for Gmail configure when no BYOK credentials are supplied. The bundled client_secret pattern is **removed** — the CLI no longer ships any Google client_secret.
- Keep BYO-client (`--client-id` + `--client-secret`) as a first-class path for users who want their own quota / verification status.
- Add `--broker-url` flag and `AGENT_EMAIL_GMAIL_BROKER_URL` env var so users can self-host the broker.
- Reject partial BYOK credentials (only one of `--client-id` / `--client-secret`) with a clear error rather than dropping into a broker flow under a different OAuth client identity.
- Saved mailbox metadata is now discriminated by `source: 'byok' | 'broker'`. Broker-mode metadata stores only `brokerUrl` + `refreshToken` — no `clientSecret` ever lands on disk for broker mailboxes. Pre-existing BYOK metadata (no `source` field) is parsed as `byok` for backward compatibility.
- Saved-metadata precedence is preserved: re-running `configure` for an existing mailbox reuses whatever mode was saved, so issue #44 stays fixed and existing BYOK users are not silently switched to broker mode on reconnect.
- Update CLI and Gmail setup documentation to describe the broker as the default path and BYOK as the override.

## Impact

- Affected specs: `cli`, `mailbox-config`, `provider-gmail`
- Affected code: `packages/email-mcp`, `packages/provider-gmail`, `apps/oauth-broker` (new)
- User-visible behavior: first-time Gmail users can run configure without entering client credentials by hand; nothing they can read or copy from the source tree authenticates as the OAuth app
- Operational impact: the project owner (or self-hoster) is now responsible for an OAuth-fronted Vercel service and CASA Tier 2 verification of the OAuth consent screen for `https://mail.google.com/`
