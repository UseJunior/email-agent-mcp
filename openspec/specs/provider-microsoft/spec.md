---
epic: Infrastructure
feature: Microsoft Graph Provider
---

## Purpose

Implements the provider interface for Microsoft Graph API email operations. Supports delegated OAuth (device code/PKCE for end users) and client credentials (for daemon deployments). Handles Graph-specific concerns: createReplyAll for threading, validation token handling (GET + POST), webhook deduplication, zombie subscription detection, size limits, and anti-spoofing via authentication headers.

### Requirement: Delegated OAuth Authentication

The system SHALL support delegated OAuth as the primary auth mode for end users, using device code flow or authorization code flow with PKCE. This avoids requiring users to register an Azure AD daemon app. Refresh tokens SHALL be persisted (encrypted) for session continuity across restarts.

#### Scenario: Device code flow
- **WHEN** `configure_mailbox` is called with `{provider: "microsoft", auth: "delegated"}`
- **THEN** the system initiates device code flow and prompts the user to authenticate in a browser

#### Scenario: Refresh token persistence
- **WHEN** the MCP server restarts
- **THEN** the system loads encrypted refresh tokens from the config directory and resumes without re-authentication

### Requirement: Client Credentials Authentication

The system SHALL support client credentials (app-only) authentication for daemon/server deployments requiring admin consent.

#### Scenario: Client credentials
- **WHEN** `configure_mailbox` is called with `{provider: "microsoft", auth: "client_credentials", clientId: "...", clientSecret: "...", tenantId: "..."}`
- **THEN** the system authenticates via `ClientSecretCredential`

### Requirement: Draft-Then-Send via createReplyAll

The system SHALL use `createReplyAll` for replies. `createReplyAll` preserves embedded images, CID references, and thread metadata. The system merges Graph's auto-quoted body with caller content rather than overwriting it. When `createReplyAll`, the body merge PATCH, or the final `/send` POST fails, `replyToMessage` SHALL return a structured `{ success: false, error: { code: 'REPLY_FAILED', recoverable: false } }` rather than silently falling back to `sendMail` — a `sendMail`-based message would lack `In-Reply-To` / `References` headers and so would not thread on the recipient side.

#### Scenario: Reply preserves Graph auto-quoted thread (plain text)
- **WHEN** the original email has prior thread history
- **AND** the system replies via `createReplyAll` with plain-text content
- **THEN** the resulting draft preserves Graph's auto-generated quoted thread divider and prior-message header block alongside the caller content

#### Scenario: cid: references survive the merge unchanged
- **WHEN** the original email contains embedded images referenced via `cid:` URLs in Graph's quoted body
- **AND** the system replies via `createReplyAll`
- **THEN** the merged draft body retains every `cid:` reference intact

#### Scenario: createReplyAll failure returns structured REPLY_FAILED
- **WHEN** `createReplyAll`, the body-merge PATCH, or the final `/send` POST throws
- **THEN** `replyToMessage` returns `{ success: false, error: { code: 'REPLY_FAILED', recoverable: false } }`
- **AND** does not call `sendMail`

### Requirement: Validation Token Handling

The system SHALL respond to Graph validation requests on BOTH GET and POST methods. The `validationToken` query parameter SHALL be HTML-escaped and returned as `200 OK` plaintext.

#### Scenario: GET validation
- **WHEN** Graph sends `GET /webhook?validationToken=abc123`
- **THEN** the system returns `200 OK` with body `abc123` (HTML-escaped, plaintext)

#### Scenario: POST validation
- **WHEN** Graph sends validation via POST with `validationToken` query param
- **THEN** the system handles it identically to GET

### Requirement: Webhook Deduplication

The system SHALL deduplicate webhook notifications using an atomic lock and in-memory map keyed by message ID. Graph sends duplicates ~9ms apart. The webhook handler SHALL return `202 Accepted` immediately and process asynchronously.

#### Scenario: Duplicate notification
- **WHEN** two notifications for the same message ID arrive 9ms apart
- **THEN** the second is skipped and the first is processed

### Requirement: Zombie Subscription Detection

The system SHALL verify subscription existence via GET before each renewal. A subscription that accepts renewal but doesn't deliver notifications is a "zombie."

#### Scenario: Zombie detected
- **WHEN** `GET /subscriptions/{id}` returns 404
- **THEN** the system logs an alert and recreates the subscription

### Requirement: Health Check Before Subscribe

The system SHALL test that the validation endpoint responds correctly before creating a subscription. This prevents silent failures.

#### Scenario: Pre-subscribe health check
- **WHEN** creating a new subscription
- **THEN** the system first sends a test validation token to its own endpoint and verifies the response

### Requirement: Size Limits

Email body max 3.5MB (Graph allows ~4MB, leave headroom for JSON envelope). Attachment max 25MB. Subject max 255 characters.

#### Scenario: Body size enforcement
- **WHEN** email body exceeds 3.5MB
- **THEN** graceful truncation is applied (see email-write spec)

### Requirement: Inbox-Scoped Message Access

The system SHALL NEVER use bare `/messages` for any read or subscription operation — it MUST always scope to `/mailFolders/Inbox/messages`. Bare `/messages` returns ALL folders (junk, sent, deleted, drafts) which is incorrect for inbox monitoring and email reading.

#### Scenario: Inbox-only subscription
- **WHEN** creating a Graph subscription
- **THEN** the resource path targets `mailFolders/Inbox/messages` only

#### Scenario: Inbox-scoped message listing
- **WHEN** listing or fetching messages from Graph
- **THEN** the API call uses `/me/mailFolders/Inbox/messages`, never `/me/messages`

#### Scenario: Inbox-scoped delta query
- **WHEN** the watcher performs a delta query
- **THEN** the API call uses `/me/mailFolders/Inbox/messages/delta`, never `/me/messages/delta`

### Requirement: Sent Message Tracking

The system SHALL use a custom extended property (`AgentEmailTrackingId`) on outbound messages for reliable lookup in Sent Items, since Graph changes message IDs on folder moves. Fallback: query by `conversationId`.

#### Scenario: Find sent message
- **WHEN** a reply is sent and the system needs the sent message ID for threading
- **THEN** it queries Sent Items by `AgentEmailTrackingId` with exponential backoff for propagation delay

### Requirement: Dual Watch Mode

The system SHALL support two email detection modes: Delta Query polling (default, works behind NAT/local) and webhook-based change notifications (production, requires public HTTPS URL).

#### Scenario: Delta Query polling (local)
- **WHEN** no public webhook URL is configured
- **THEN** the system polls via Delta Query at a configurable interval (default 30s)

#### Scenario: Webhook mode (production)
- **WHEN** a public HTTPS webhook URL is configured
- **THEN** the system registers for Graph change notifications

### Requirement: Delta Query Field Selection

The system SHALL use `$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments` on Delta Query requests for efficiency. This avoids fetching full message bodies during watcher polling.

#### Scenario: Delta query uses $select
- **WHEN** the system issues a Delta Query request for inbox messages
- **THEN** the request includes `$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments`

#### Scenario: Selected fields sufficient for wake payload
- **WHEN** the watcher constructs a wake payload from delta query results
- **THEN** all required payload fields (sender, recipients, subject, attachment indicator) are available from the `$select` fields

### Requirement: Email Address Retrieval from /me

During `configure_mailbox`, the system SHALL fetch the user's email address from the Graph `/me` endpoint. The `mail` property SHALL be used as the canonical email address. If `mail` is null (common for B2B/guest accounts), the system SHALL fall back to `userPrincipalName`.

#### Scenario: Email from /me mail property
- **WHEN** `configure_mailbox` fetches `/me` and the response includes `mail: "test-user@example.com"`
- **THEN** the stored `emailAddress` is `test-user@example.com`

#### Scenario: Fallback to userPrincipalName
- **WHEN** `configure_mailbox` fetches `/me` and `mail` is null
- **AND** `userPrincipalName` is `test-user@example.onmicrosoft.com`
- **THEN** the stored `emailAddress` is `test-user@example.onmicrosoft.com`

### Requirement: ESM Compatibility

The system SHALL use explicit `.js` import extensions for the Microsoft Graph SDK to satisfy Node.js 20+ ESM resolution requirements. If SDK interop friction appears, the system SHALL fallback to direct REST + token auth.

#### Scenario: ESM import resolution
- **WHEN** the provider is imported in an ESM TypeScript project
- **THEN** all Graph SDK imports use explicit `.js` extensions

### Requirement: NemoClaw Compatibility

The system SHALL document required egress domains for NemoClaw sandbox policy: `graph.microsoft.com`, `login.microsoftonline.com`.

#### Scenario: NemoClaw egress config
- **WHEN** running in NemoClaw
- **THEN** `configure --nemoclaw` adds these domains to the egress policy
