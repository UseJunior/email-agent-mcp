## 1. Logging helper

- [ ] 1.1 Add `apps/oauth-broker/lib/log.ts` — zero imports. Export `redactQuery(value)` (returns the substring before `?`, passes through non-strings) and `logEvent(fields)` (emits `console.log(JSON.stringify({ t: 'broker_request', ...fields }))`).
- [ ] 1.2 Add a helper to derive a non-reversible correlation id from a raw `session_id` (SHA-256 prefix or fixed truncation) so a single flow can be traced across routes without logging the raw id. If `node:crypto` would break the zero-import rule, truncation-only is acceptable; document the choice in the file header.
- [ ] 1.3 Add `apps/oauth-broker/lib/log.test.ts`: assert `redactQuery('https://x/api/callback?code=abc&state=def')` drops the query; assert a `logEvent` line is valid JSON carrying `t: 'broker_request'`; assert token-shaped inputs never appear in output when passed through the intended call shape.

## 2. Instrument handlers

- [ ] 2.1 `api/sessions.ts` — log outcome `created` | `invalid_session_id` | `invalid_pickup_hash` | `invalid_request` | `session_exists`, with `status`.
- [ ] 2.2 `api/start.ts` — log outcome `redirected` | `invalid_session` | `session_expired_or_unknown` | `session_already_advanced`.
- [ ] 2.3 `api/callback.ts` — log outcome `ready` | `denied` | `exchange_failed` | `invalid_state`. Never log `code` or `state`; apply `redactQuery` to any URL.
- [ ] 2.4 `api/tickets/claim.ts` — log outcome `claimed` | `pending` | `invalid_pickup_secret` | `not_found` | terminal (`denied`/`exchange_failed`/`expired`/`consumed`). Never log `pickup_secret`.
- [ ] 2.5 `api/refresh.ts` — log outcome `refreshed` | `refresh_failed`. Never log `refresh_token` or `client_secret`.
- [ ] 2.6 Each handler logs exactly one line per request, including `route`, `method`, `status`, `host`, `ua`, correlation id, and `dur_ms`.

## 3. Spec + verification

- [ ] 3.1 Apply the observability delta: scope the stdout prohibition to the MCP server and add the broker-request-logging requirement.
- [ ] 3.2 Add tests tagged to the new spec requirement so the OpenSpec traceability gate (`scripts/check-spec-coverage.mjs`) passes.
- [ ] 3.3 `npm run test:run` and `npm run lint` pass in `apps/oauth-broker`; root `npm run` spec-coverage gate passes.
- [ ] 3.4 Grep the emitted log shape to confirm no `code`/`state`/`access_token`/`refresh_token`/`client_secret`/`pickup_secret`/`pickup_hash`/raw `session_id` field is ever present.
