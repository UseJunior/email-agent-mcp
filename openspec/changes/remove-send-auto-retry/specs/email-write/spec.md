## MODIFIED Requirements

### Requirement: Delivery Failure Handling

Delivery operations (`send_email`, `reply_to_email`, `send_draft`) are non-idempotent: the underlying provider endpoints (Graph `POST /sendMail`, draft `/send`, Gmail `users.messages.send`) offer no idempotency key, and a transport failure after the provider accepted the message is indistinguishable from one before it. The system SHALL therefore invoke the provider delivery method exactly once per delivery request at the action layer and SHALL NOT automatically retry a failed delivery, regardless of how transient the failure appears. (A transport-level re-issue of a request rejected with an authentication 401 after a token refresh is permitted: a 401-rejected submission was never accepted, so it cannot duplicate delivery.) On failure, the system SHALL return a structured error so the agent can inform the user, who decides whether to resend.

Scheduled-send submission retains its existing treatment: no automatic retry, and ambiguous outcomes are reported as `SCHEDULE_SEND_STATUS_UNKNOWN` with guidance not to schedule a duplicate.

#### Scenario: Transient delivery failure is not retried
- **WHEN** a send attempt fails with a transient-looking error (e.g. 503, network timeout)
- **THEN** the system makes no further dispatch attempts, because the message may already have been accepted and a retry could deliver a duplicate
- **AND** the system returns a structured error identifying the failure

#### Scenario: Deterministic delivery failure fails fast
- **WHEN** a send attempt fails with a deterministic provider rejection (e.g. HTTP 400 invalid recipient)
- **THEN** the system returns a structured error immediately, without backoff delay

#### Scenario: Permanent failure notification
- **WHEN** a send permanently fails (e.g., invalid recipient)
- **THEN** the system returns `{success: false, error: {code, message, recoverable: false}}`
- **AND** when the provider classified the failure (a `ProviderError`), its code (e.g. `INVALID_RECIPIENT`) is preserved; unclassified provider rejections surface the action's fallback code (e.g. `SEND_FAILED`) pending provider-boundary error normalization (#177)
