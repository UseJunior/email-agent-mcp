## ADDED Requirements

### Requirement: Gmail Error Classification

The Gmail provider SHALL normalize delivery errors at the dispatch boundary. It SHALL classify HTTP 429 and HTTP 403 errors with a structured `rateLimitExceeded`, `userRateLimitExceeded`, or `quotaExceeded` reason as `RATE_LIMITED`, without matching error-message text.

#### Scenario: Gmail 403 quota form is rate limited
- **WHEN** Gmail returns HTTP 403 with `errors[0].reason` equal to `userRateLimitExceeded`
- **THEN** the provider returns a `RATE_LIMITED` error rather than `PERMISSION_DENIED`

#### Scenario: Gmail 429 is rate limited
- **WHEN** Gmail returns HTTP 429
- **THEN** the provider returns a `RATE_LIMITED` error
