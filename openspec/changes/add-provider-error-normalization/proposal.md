# Normalize provider errors at the provider boundary

## Why

#179 removed automatic retry from delivery because Graph and Gmail sends are non-idempotent. That closed the machine's ability to duplicate a send, but left the caller unable to tell two very different failures apart:

- Graph rejected the request with a 400 — the message was definitely **not** delivered.
- The response was lost after submission — the message **may already have been** delivered.

Both surface today as `{ code: 'SEND_FAILED', recoverable: false }` with a raw provider message. An LLM caller that sees the second one will resend, and deliver the email twice. The duplicate-send hazard was moved up a layer, not removed.

The underlying cause is that thrown provider errors bypass the `ProviderError` taxonomy entirely. Microsoft throws `GraphApiError extends Error`; Gmail propagates raw googleapis errors. `handleProviderError` preserves only `ProviderError`, so everything else collapses to the action's fallback code.

Two requirements in `provider-interface` — Error Normalization and Rate Limit Handling — describe behaviour that no production code implements. This change makes them true.

## What Changes

- **Classification vocabulary in email-core.** `classifyHttpStatus` (4xx terminal / 5xx ambiguous-for-delivery / 429 with `retryAfter`), `classifyTransportError` (walks the `cause` chain; `connect-failed` only for codes proving no request bytes were written), `parseRetryAfter`, and `isProviderError` — a structural guard, because `instanceof` is unsafe across package boundaries.
- **`SEND_STATUS_UNKNOWN`** for delivery failures whose outcome cannot be proven, mirroring the existing `SCHEDULE_SEND_STATUS_UNKNOWN` precedent, with guidance in the message string not to resend and a concrete artifact to inspect.
- **Delivery boundaries only.** `sendMessage`, `replyToMessage`, and `sendDraft` classify their dispatch failures. Read paths keep throwing `GraphApiError` — see Impact.
- **`replyToMessage` splits preparation from dispatch.** Preparing the reply draft is pre-dispatch and stays terminal; only the `/send` POST can be ambiguous.
- **`withRetry` gate inverted** to retry only what is explicitly marked recoverable, honouring `Retry-After` as a delay floor, with delivery never retryable by construction.
- **Gmail parity** — a `ProviderError`-producing boundary, including Gmail's 403-with-`rateLimitExceeded` quota form as well as 429.

## Impact

- **Behavioural change, spec'd below:** a `replyToMessage` failure at the `/send` POST now returns `SEND_STATUS_UNKNOWN` (or a terminal classified code) instead of `REPLY_FAILED`. The anti-fallback guarantee the old requirement was protecting — never silently falling back to `sendMail` — is unchanged and still asserted.
- **Read paths are deliberately NOT normalized.** The CLI watcher routes poll failures through `isAuthError`, which recognizes `GraphApiError` and not `ProviderError`; normalizing `listMessages` would make the watcher stop reconnecting after token expiry and fail silently for the life of the process. Normalizing read paths requires teaching `isAuthError` about normalized codes first, and is out of scope here.
- `retryAfter` is surfaced to callers; `provider` is not (the caller already chose the mailbox).
- Request timeouts remain out of scope: there is no `AbortController` in the transport today, and adding one would manufacture ambiguity on every abort.
