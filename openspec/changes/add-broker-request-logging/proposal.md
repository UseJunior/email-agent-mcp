## Why

The Gmail OAuth broker (`apps/oauth-broker`) emits no logs — `grep -rn 'console\.' apps/oauth-broker/api apps/oauth-broker/lib` returns nothing. Every route handler runs silent. For most of the broker's life it was also undeployed, returning Vercel `DEPLOYMENT_NOT_FOUND`, so we have zero data on whether any user ever attempted broker-mediated Gmail configure. Once the broker is live we want each request to leave one structured line in Vercel's runtime logs, so "is anyone actually connecting Gmail?" and "where in the flow do attempts fail?" become answerable (see issue #142).

This also forces a decision the current `observability` spec does not address: that spec's first requirement declares logging to **stdout** a *critical bug*, because in the MCP server stdout is the stdio transport and logging there corrupts the protocol. The broker is a different runtime — a standalone Vercel serverless app with no MCP stdio transport — where stdout is simply captured as a runtime log and is the house pattern for Vercel functions (`dev-website/api/csp-report.mjs`). Introducing broker logging without recording this distinction would read as violating the spec's headline rule. This change scopes the stdout prohibition to the MCP server and records the broker's stdout logging as a deliberate, spec-sanctioned exception.

## What Changes

- Add a pure, zero-import, unit-tested helper `apps/oauth-broker/lib/log.ts` exporting `logEvent(fields)` (emits one `JSON.stringify` line with a `t` discriminator) and `redactQuery(url)` (strips query strings before logging URLs). Colocated `lib/log.test.ts` (vitest), matching the existing `lib/*.test.ts` shape.
- Call `logEvent` once per request in each of the five handlers: `api/sessions.ts`, `api/start.ts`, `api/callback.ts`, `api/tickets/claim.ts`, `api/refresh.ts`. Each line carries `t: "broker_request"`, `route`, `method`, `status`, a coarse `outcome` label, `host`, `ua`, a hashed/truncated session correlation id, and `dur_ms`.
- Enforce PII rules in the helper and at every call site: never log `code`, `state`, `access_token`, `refresh_token`, `client_secret`, the `Authorization` header, `pickup_secret`, `pickup_hash`, or a raw `session_id`; never log client IP; strip query strings from any logged URL.
- Scope the existing "log exclusively to stderr / stdout is a critical bug" requirement to the MCP server, and add a broker-logging requirement that records the stdout exception and its rationale.
- No log drain / BigQuery ingester in this change — that is a separate, later proposal. Vercel runtime logs + Observability are sufficient for the immediate question.

## Impact

- Affected specs: `observability`
- Affected code: `apps/oauth-broker/lib/log.ts` (new), `apps/oauth-broker/lib/log.test.ts` (new), `apps/oauth-broker/api/sessions.ts`, `apps/oauth-broker/api/start.ts`, `apps/oauth-broker/api/callback.ts`, `apps/oauth-broker/api/tickets/claim.ts`, `apps/oauth-broker/api/refresh.ts`
- User-visible behavior: none. No change to the OAuth flow, request/response contracts, or MCP tool surface. This is observability-only, confined to the broker deployment.
- No new runtime dependencies.
- Out of scope: durable log drain → BigQuery; rate limiting / abuse alerting (tracked separately); any change to MCP-server logging.
