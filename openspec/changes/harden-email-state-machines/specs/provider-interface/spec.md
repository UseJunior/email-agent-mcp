## MODIFIED Requirements

### Requirement: Authentication Lifecycle

The system SHALL serialize connect, refresh and disconnect transitions and invalidate stale completions. Authenticated request recovery SHALL require an auth-related rejection and operation kind. Delivery SHALL NOT replay after timeout, transport ambiguity or 5xx; the existing single recovery retry after explicit 401 rejection MAY remain. Retry waits SHALL be cancellable.

#### Scenario: Token refresh
- **WHEN** a request receives an auth-related rejection and recovery is safe for its operation kind
- **THEN** the system SHALL acquire a valid token through shared refresh and retry at most once

#### Scenario: Unrelated failure at token expiry
- **WHEN** a request fails for a non-authentication reason while a token is expired
- **THEN** expiry alone SHALL NOT authorize replay
