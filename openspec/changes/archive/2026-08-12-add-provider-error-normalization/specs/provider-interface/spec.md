## MODIFIED Requirements

### Requirement: Error Normalization

The system SHALL normalize provider-specific errors into common error types with code, message, provider name, recoverable flag, and optional retry-after value. HTTP 4xx errors SHALL be terminal provider rejections, while a delivery 5xx or ambiguous transport error SHALL report `SEND_STATUS_UNKNOWN`.

#### Scenario: Graph 429 normalized
- **WHEN** Graph API returns 429 Too Many Requests
- **THEN** the error is normalized to `{code: "RATE_LIMITED", message: "...", provider: "microsoft", recoverable: true, retryAfter: 30}`

#### Scenario: Ambiguous delivery normalized
- **WHEN** a provider loses a delivery response after dispatch
- **THEN** the error is normalized to `{code: "SEND_STATUS_UNKNOWN", recoverable: false}`

### Requirement: Rate Limit Handling

The system SHALL detect provider throttle responses, apply exponential backoff with jitter only to retryable idempotent operations, and surface quota information through `retryAfter` when supplied. Delivery operations SHALL never be automatically retried.

#### Scenario: Exponential backoff
- **WHEN** an idempotent provider operation returns 429
- **THEN** the system retries with exponential backoff (1s, 2s, 4s) up to a configurable max

#### Scenario: Delivery throttle is not retried
- **WHEN** a delivery operation returns 429
- **THEN** the system returns `RATE_LIMITED` without reissuing the delivery

## ADDED Requirements

### Requirement: Operation-Aware Retry Policy

The system SHALL retry only normalized recoverable failures from idempotent reads or writes. Delivery operations SHALL never be retried, even when the provider marks an error recoverable.

#### Scenario: Plain error is not retried
- **WHEN** an idempotent operation throws an unnormalized error
- **THEN** the system fails immediately without retrying

#### Scenario: Delivery is never retried
- **WHEN** a delivery operation throws a recoverable provider error
- **THEN** the system makes exactly one dispatch attempt
