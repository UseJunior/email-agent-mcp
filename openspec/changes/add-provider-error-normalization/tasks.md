# Tasks

## 1. Classification vocabulary (email-core)
- [x] 1.1 `isProviderError` structural guard; swap all four `instanceof ProviderError` sites
- [x] 1.2 `classifyHttpStatus`, `classifyTransportError`, `parseRetryAfter`, `SEND_STATUS_UNKNOWN`
- [x] 1.3 `OperationKind` / `isRetryable`; invert the `withRetry` gate and honour `Retry-After` as a delay floor
- [x] 1.4 Export the new surface from the package entry point
- [ ] 1.5 Unit tests: structural guard across a package boundary, each transport code class, the 4xx/5xx/429 table, retry gate

## 2. Microsoft provider
- [x] 2.1 `GraphApiError` carries `retryAfterSeconds`; capture `Retry-After` at all four client verbs
- [x] 2.2 `classifyGraphDelivery` + `graphDeliveryError` message builder
- [x] 2.3 Wrap dispatch only in `sendMessage` and `sendDraft`
- [x] 2.4 Split `replyToMessage` into preparation (terminal) and dispatch (classified)
- [x] 2.5 Fold `scheduledDraftSendFailure` onto the shared classifier
- [x] 2.6 Tests for terminal 4xx, ambiguous 5xx, and terminal preparation failure
- [ ] 2.7 Leave read paths throwing `GraphApiError` — add a watcher regression test proving `isAuthError` still fires on a residual 401

## 3. Gmail provider
- [ ] 3.1 `gmailProviderError`, reusing the relocated `getErrorStatus` / `getErrorMessage`
- [ ] 3.2 Map 403 `rateLimitExceeded` / `userRateLimitExceeded` / `quotaExceeded` AND 429 to `RATE_LIMITED` from the structured `errors[].reason`
- [ ] 3.3 Harden `getErrorStatus` against numeric-string codes
- [ ] 3.4 Wrap the three delivery methods with the same preparation/dispatch split

## 4. Action layer (email-core)
- [ ] 4.1 Delivery fallback codes become `SEND_STATUS_UNKNOWN`, so an unclassified failure fails safe
- [ ] 4.2 Surface `retryAfter` in the four delivery output schemas
- [ ] 4.3 Charge rate-limit quota on ambiguous sends, matching the scheduled-send precedent
- [ ] 4.4 Pre-send draft lookup uses `withRetry({ operation: 'idempotent-read' })`
- [ ] 4.5 One guidance sentence in the three delivery tool descriptions

## 5. Specs
- [x] 5.1 `provider-microsoft` delta
- [ ] 5.2 `email-write` delta — ambiguous-delivery scenarios, and drop the "pending #177" clause
- [ ] 5.3 `provider-interface` delta — Error Normalization, Rate Limit Handling, Operation-Aware Retry Policy
- [ ] 5.4 `provider-gmail` delta
- [ ] 5.5 `openspec validate --strict` and `npm run check:spec-coverage`
