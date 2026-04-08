---
epic: Infrastructure
feature: Provider Abstraction
---

## Purpose

Defines capability-based provider interfaces (EmailReader, EmailSender, EmailSubscriber), provider registration via dynamic import, error normalization, authentication lifecycle, and rate limit handling. Providers implement the interfaces they support.

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
- **WHEN** an access token expires during an operation
- **THEN** the system refreshes the token using the stored refresh token and retries the operation
