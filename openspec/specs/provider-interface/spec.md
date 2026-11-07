---
epic: Infrastructure
feature: Provider Abstraction
---

## Purpose

Defines capability-based provider interfaces (EmailReader, EmailSender, EmailSubscriber), provider registration via dynamic import, error normalization, authentication lifecycle, and rate limit handling. Providers implement the interfaces they support.
## Requirements
### Requirement: Capability Interfaces

The system SHALL define capability-based interfaces: `EmailReader` (list, get, search, getThread), `EmailSender` (send, reply, createDraft, sendDraft), and `EmailSubscriber` (subscribe, unsubscribe). Providers implement what they support. On the write path, `EmailSender` implementations SHALL inspect `ComposeMessage.bodyHtml` (and for reply methods, `ReplyOptions.bodyHtml`) to decide the transport content type: when set, send as HTML; otherwise send as plain text.

#### Scenario: Provider supports read and send
- **WHEN** a provider implements `EmailReader` and `EmailSender`
- **THEN** read and write actions work; subscribe actions return "not supported by this provider"

#### Scenario: Provider honors bodyHtml on send
- **WHEN** `sendMessage` is called with a `ComposeMessage` that has `bodyHtml` set
- **THEN** the provider transports the email with HTML content type (`contentType: "HTML"` for Graph, `Content-Type: text/html` for Gmail)
- **AND** the content is the value of `bodyHtml`

#### Scenario: Provider sends plain text when bodyHtml is absent
- **WHEN** `sendMessage` is called with a `ComposeMessage` that has only `body` set (no `bodyHtml`)
- **THEN** the provider transports the email with plain-text content type (`contentType: "Text"` for Graph, `Content-Type: text/plain` for Gmail)
- **AND** newlines in `body` are preserved without requiring `<br>` markup

#### Scenario: Provider honors ReplyOptions.bodyHtml
- **WHEN** `replyToMessage` is called with `opts.bodyHtml` set
- **THEN** the reply is transported with HTML content type and the `bodyHtml` content
- **AND** the plain `body` argument serves as the fallback when `opts.bodyHtml` is undefined

#### Scenario: createDraft and updateDraft honor bodyHtml
- **WHEN** `createDraft` or `updateDraft` is called with `bodyHtml` set on the `ComposeMessage`
- **THEN** the draft is stored with HTML content type and can be sent later without re-rendering

### Requirement: Provider Registration

The system SHALL discover installed providers via dynamic import of `@usejunior/provider-*` packages and register them in a provider registry.

#### Scenario: Dynamic discovery
- **WHEN** the MCP server starts
- **THEN** it discovers installed provider packages and makes them available for `configure_mailbox`

### Requirement: Error Normalization

The system SHALL normalize provider-specific errors into common error types with code, message, provider name, and recoverable flag.

#### Scenario: Graph 429 normalized
- **WHEN** Graph API returns 429 Too Many Requests
- **THEN** the error is normalized to `{code: "RATE_LIMITED", message: "...", provider: "microsoft", recoverable: true, retryAfter: 30}`

### Requirement: Rate Limit Handling

The system SHALL detect 429/throttle responses across providers, apply exponential backoff with jitter, and surface quota information.

#### Scenario: Exponential backoff
- **WHEN** a provider returns 429
- **THEN** the system retries with exponential backoff (1s, 2s, 4s) up to a configurable max

### Requirement: Authentication Lifecycle

The system SHALL manage the authentication lifecycle: connect (initial auth), refresh (token renewal), and disconnect (cleanup).

#### Scenario: Token refresh
- **WHEN** a read operation fails with an explicit authentication error
- **THEN** authenticated recovery may refresh credentials and retry once
- **AND** token expiry alone does not authorize replay of a failed operation

### Requirement: Authenticated Retry Safety

Authenticated retry SHALL require an operation kind and an auth-error classifier. It SHALL perform at most one recovery and replay, and delivery SHALL require an explicit authentication rejection proving the request was rejected. Timeout, server error and ambiguous delivery SHALL NOT authorize replay. The deprecated `withAutoRefresh(auth, fn)` export SHALL remain callable, default to delivery safety and recognize only HTTP 401 as explicit rejection; callers specifying a read/write operation may also recover `ProviderError` code `AUTH_REQUIRED`. Expiry SHALL NOT authorize replay. Existing MCP wire fields SHALL remain unchanged.

#### Scenario: Compatibility wrapper requires explicit rejection for unspecified operation
- **WHEN** a legacy caller omits the operation kind
- **THEN** an authentication code alone SHALL NOT authorize delivery replay
- **AND** an explicit HTTP 401 may authorize one recovery retry

#### Scenario: Recovery is exhausted after one replay and preserves the final error
- **WHEN** the replay also fails
- **THEN** its error SHALL propagate without another refresh or attempt

#### Scenario: Failed recovery preserves rejection without dispatch
- **WHEN** recovery reports failure
- **THEN** the original rejection SHALL propagate without replay

### Requirement: Cancellable Retry Backoff

Generic retries SHALL remain limited to recoverable provider failures on non-delivery operations. Retry settings SHALL be finite and nonnegative, and maxRetries SHALL be an integer. AbortSignal SHALL interrupt operation/recovery waits and backoff, and pre-aborted calls SHALL NOT dispatch. Retry-After SHALL remain a minimum delay independent of jitter and maxDelay; waits exceeding the platform timer limit SHALL be chunked without reducing that floor. Exhaustion SHALL preserve the last failure.

#### Scenario: Server floor above maxDelay eventually permits retry at the floor
- **WHEN** a server delay exceeds local maxDelay
- **THEN** the retry SHALL wait for the server floor even with minimum jitter

#### Scenario: Retry exhaustion preserves the last provider error
- **WHEN** a recoverable operation consumes its retry budget
- **THEN** the final provider error SHALL propagate unchanged

#### Scenario: Ambiguous delivery bypasses generic retries even if marked recoverable
- **WHEN** a delivery failure is marked recoverable
- **THEN** generic retries SHALL still dispatch only once

### Requirement: Optional Folder and Rule Capabilities

The provider abstraction SHALL define `EmailFolderManager` and `EmailRuleManager` as optional capabilities on the combined `EmailProvider` type and SHALL advertise `folders` and `rules` in provider capability metadata.

#### Scenario: Provider omits optional capabilities
- **WHEN** a provider implements email reading and sending but not folder or rule management
- **THEN** it remains a valid `EmailProvider`
- **AND** folder and rule actions can detect the missing capability

### Requirement: Microsoft Mailbox Settings Consent

The Microsoft delegated authentication configuration SHALL request `MailboxSettings.ReadWrite` in both the short and full-URL Graph scope lists.

#### Scenario: Existing user reconnects
- **WHEN** an existing Microsoft user reconnects after this capability is introduced
- **THEN** the consent request includes `MailboxSettings.ReadWrite`
- **AND** user-facing documentation states that re-consent is required

