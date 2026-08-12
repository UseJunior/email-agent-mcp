## Why

The immediate-delivery boundaries — `send_email → sendMessage`, `reply_to_email → replyToMessage`, `send_draft → sendDraft` — are wrapped in `withRetry` (4 attempts, exponential backoff). Delivery is non-idempotent: Graph `POST /sendMail` returns 202 with no body and no idempotency key, and Gmail `users.messages.send` is equivalent. A timeout or 5xx that arrives after the provider accepted the message is indistinguishable from a pre-acceptance failure, so each automatic retry is an independent submission that can deliver the same email again. The Microsoft provider additionally regenerates its tracking id per attempt, so duplicates cannot even be correlated afterwards.

The retry gate is also ineffective: its only escape hatch is `err instanceof ProviderError && !err.recoverable`, but the Microsoft provider throws `GraphApiError extends Error` and Gmail throws plain googleapis errors — so even deterministic 400s (invalid recipient) are retried four times, stalling the caller ~3.5–7 seconds for a failure that can never succeed.

The scheduled-send path already embodies the correct treatment: it deliberately avoids `withRetry` ("a lost response after draft creation could otherwise queue a duplicate") and returns `SCHEDULE_SEND_STATUS_UNKNOWN` on ambiguous outcomes. The immediate-send path is the inconsistent one.

Validated adversarially by a dynamic peer review (execution-confirmed: one deterministic 400 produced four `/sendMail` POSTs with four distinct tracking ids). See issue #173.

## What Changes

- **Delivery operations make exactly one provider attempt.** `send_email`, `reply_to_email`, and `send_draft` call their provider method once and surface the structured error immediately on failure. No automatic retry at the action layer.
- The "Delivery Failure Handling" requirement in `email-write` is rewritten: automatic retry-with-backoff is **removed** for non-idempotent delivery operations, because the system cannot prove a transient failure occurred before the message was accepted.
- Scheduled send (`scheduleMessage`/`scheduleDraft`, deferred-send draft-then-send) is untouched.
- Non-delivery operations (reads, draft creation read-backs, etc.) keep their existing retry behavior.

## Non-goals (follow-up work)

- Provider-boundary error normalization (terminal 4xx codes, 429/`retryAfter`, a `SEND_STATUS_UNKNOWN` result for ambiguous delivery failures) is a separate change.
- Operation-aware transport retry for failures provably occurring before request transmission (DNS failure, connection refused) may later reintroduce a narrow, safe retry.

## Impact

- Affected specs: `email-write` (Delivery Failure Handling requirement)
- Affected code: `packages/email-core/src/actions/send.ts`, `reply.ts`, `draft.ts` (send_draft path)
- User-visible behavior: deterministic failures return ~3.5–7s faster; genuinely transient pre-acceptance failures are no longer masked by automatic retry — the caller receives a structured error and decides whether to resend. This removes the only path by which the system could silently deliver duplicate email.
