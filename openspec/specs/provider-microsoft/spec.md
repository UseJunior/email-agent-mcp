---
epic: Infrastructure
feature: Microsoft Graph Provider
---

## Purpose

Implements the provider interface for Microsoft Graph API email operations. Supports delegated OAuth (device code/PKCE for end users) and client credentials (for daemon deployments). Handles Graph-specific concerns: createReplyAll for threading, validation token handling (GET + POST), webhook deduplication, zombie subscription detection, size limits, and anti-spoofing via authentication headers.
## Requirements
### Requirement: Explicit Graph Auth Retry

Graph HTTP wrappers SHALL pass an operation kind to authenticated retry: GET and binary GET are reads, PATCH/DELETE and known resource POSTs are writes, and sendMail/send and unknown POST actions are delivery. Only a received HTTP 401 SHALL authorize at most one recovery retry, including rejected delivery. Timeout, 5xx and other failures SHALL NOT cause auth replay. Concurrent requests SHALL share active recovery; AbortSignal SHALL interrupt an individual waiter without cancelling another request's shared recovery. Existing constructor and method calls SHALL remain compatible, with optional signal parameters added for POST, PATCH, DELETE and binary GET.

#### Scenario: Delivery 401 permits one recovery retry with fresh credentials
- **WHEN** Graph explicitly rejects delivery with HTTP 401 and recovery succeeds
- **THEN** the request SHALL be retried once using fresh credentials

#### Scenario: Concurrent auth recovery survives cancellation of one waiter
- **WHEN** concurrent rejected requests wait on recovery and one request is cancelled
- **THEN** only that wait SHALL be cancelled
- **AND** the other request may retry after the shared recovery succeeds

#### Scenario: Cancellation interrupts token waiting before delivery dispatch
- **WHEN** cancellation occurs while token acquisition is pending
- **THEN** the caller SHALL stop waiting and SHALL NOT dispatch delivery

### Requirement: Delegated OAuth Authentication

The system SHALL support delegated OAuth as the primary auth mode for end users, using device code flow or authorization code flow with PKCE. This avoids requiring users to register an Azure AD daemon app. MSAL SHALL own token cache persistence; the existing mailbox metadata route SHALL store only the authentication record, cache identity and profile metadata.

Delegated authentication SHALL use explicit disconnected, connecting, connected, refreshing, reauth_required and disconnecting states. Credential-changing operations SHALL serialize; concurrent token acquisition/refresh callers and concurrent reconnect callers SHALL each share their pending acquisition. Disconnect SHALL immediately invalidate pending operations before draining them, preventing stale credentials, records, expiry or metadata publication. Runtime disconnect SHALL NOT delete saved profiles. Recognized terminal authentication failures SHALL require configuration, transient failures SHALL retain the prior coherent session, and successful authentication SHALL clear stale reauth status. Existing public methods and health getters SHALL remain compatibility projections of these states, without changing MCP wire fields.

#### Scenario: Device code flow
- **WHEN** `configure_mailbox` is called with `{provider: "microsoft", auth: "delegated"}`
- **THEN** the system initiates device code flow and prompts the user to authenticate in a browser

#### Scenario: Refresh token persistence
- **WHEN** the MCP server restarts
- **THEN** the system loads the authentication record and cache identity from mailbox metadata and silently resumes using the MSAL-owned persistent cache

#### Scenario: Disconnect invalidates delegated acquisition in either completion order
- **WHEN** connect, reconnect or token acquisition overlaps disconnect
- **THEN** disconnect clears runtime session projections and stale acquisition cannot restore them
- **AND** operations invalidated before completion reject without publishing saved metadata

#### Scenario: Concurrent delegated refresh callers share success and failure
- **WHEN** token acquisition and refresh callers overlap
- **THEN** one MSAL acquisition supplies all callers with the same success or failure
- **AND** a later success clears stale reauth status

#### Scenario: Concurrent delegated reconnect callers share success and failure
- **WHEN** reconnect and tryReconnect callers overlap
- **THEN** one silent reconnect supplies their results, preserving tryReconnect's boolean API

#### Scenario: Transient delegated failures retain the prior coherent session
- **WHEN** connect, reconnect or token acquisition fails transiently
- **THEN** the prior credential, authentication record, expiry and profile remain a coherent session

#### Scenario: Delegated metadata persistence failure retains runtime authentication
- **WHEN** metadata persistence fails after successful interactive authentication
- **THEN** the error identifies metadata persistence failure and the valid runtime session remains usable
- **AND** a later save uses the existing mailbox metadata path

#### Scenario: Disconnect prevents pending delegated metadata publication
- **WHEN** disconnect occurs while metadata is being staged
- **THEN** the pending write cannot replace the saved profile and its temporary file is removed

#### Scenario: Unconsented delegated scopes fail silently without stdout prompts
- **WHEN** cached credentials cannot satisfy the selected scope profile
- **THEN** reconnect requires configuration without initiating interactive authentication or prompting on stdout
- **AND** AuthenticationRequiredError marks both reconnect and token acquisition as requiring reauthentication

### Requirement: Client Credentials Authentication

The system SHALL support client credentials (app-only) authentication for daemon/server deployments requiring admin consent. The manager SHALL own an explicit session lifecycle, publish credential/token/expiry together, serialize connect and refresh mutations, and share concurrent refresh work. Disconnect SHALL invalidate pending acquisitions synchronously. Transient failures SHALL retain the prior coherent session; terminal credential failures SHALL require reauthentication until a successful acquisition replaces that state. The existing `getAccessToken(): Promise<string | undefined>` interface SHALL remain available.

#### Scenario: Client credentials
- **WHEN** `configure_mailbox` is called with `{provider: "microsoft", auth: "client_credentials", clientId: "...", clientSecret: "...", tenantId: "..."}`
- **THEN** the system authenticates via `ClientSecretCredential`

#### Scenario: Client credentials disconnect invalidates acquisition in both orders
- **WHEN** disconnect occurs before or after a connect, refresh, or expiry-triggered acquisition completes
- **THEN** runtime access is revoked immediately and stale completion cannot restore it
- **AND** disconnect does not delete Microsoft mailbox metadata or manage the MSAL cache

#### Scenario: Concurrent expired client credentials calls share refresh success and failure
- **WHEN** concurrent token and explicit refresh callers require acquisition
- **THEN** one acquisition supplies the shared success or failure
- **AND** token and expiry are published together on success

#### Scenario: Failed client credentials acquisition retains a coherent prior session
- **WHEN** connect or refresh fails transiently or returns no token
- **THEN** the prior session remains intact, or the manager remains disconnected if no session existed
- **AND** missing configuration never creates a partially connected credential

#### Scenario: Successful client credentials acquisition replaces prior reauthentication state
- **WHEN** acquisition succeeds after a terminal authentication failure
- **THEN** the new session replaces the prior reauthentication state
- **AND** a transient retry failure preserves the reauthentication requirement

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

#### Scenario: update_draft preserves Graph auto-quoted thread
- **WHEN** `update_draft` is called with a new body on a draft that contains Graph's auto-quoted thread (divider + `From:/Sent:/To:/Subject:` block)
- **THEN** the resulting PATCH replaces only the caller content above the divider
- **AND** preserves the divider, header block, and prior message body intact

#### Scenario: update_draft on a fresh draft replaces body wholesale
- **WHEN** `update_draft` is called on a draft with no quoted-thread marker
- **THEN** the body is PATCHed wholesale via `buildGraphBody` (existing behavior unchanged)

### Requirement: Reply To Recipients

Graph's `createReply` / `createReplyAll` auto-populate the draft's To from the parent message. When `ReplyOptions.to` is supplied and non-empty, the follow-up PATCH SHALL set `toRecipients` to exactly those addresses, replacing Graph's derived To. Unlike `ccRecipients` and `bccRecipients`, which merge with the thread's, `toRecipients` SHALL NOT merge — merging would leave the parent's sender addressed, which is the failure this replaces. When `to` is absent or empty, the PATCH SHALL omit `toRecipients` entirely so Graph's derived To stands.

On the `createReplyAll` endpoint, Graph places both the parent's sender and the thread's other To participants on the draft's To. When an explicit `to` displaces them, those addresses SHALL be merged into `ccRecipients` with case-insensitive deduplication, so a reply-all's audience is never narrowed by supplying `to`. Addresses now on the caller's To SHALL be excluded from that demotion. On the `createReply` endpoint no demotion SHALL occur.

#### Scenario: explicit to replaces Graph auto-populated recipients (issue #164)
- **WHEN** a reply draft is created against a parent the mailbox owner sent, with `replyAll: false` and an explicit `to`
- **THEN** the PATCH sets `toRecipients` to the caller's addresses, with display names preserved
- **AND** the mailbox owner's auto-populated address is not among them

#### Scenario: explicit to with several addresses patches all of them (issue #164)
- **WHEN** a reply draft is created with several `to` entries
- **THEN** the PATCH carries every address in order

#### Scenario: explicit to under reply-all demotes displaced participants to Cc (issue #164)
- **WHEN** `createReplyAll` returns several auto-populated `toRecipients` and the caller supplies an explicit `to`
- **THEN** the PATCH addresses only the caller's recipients on `toRecipients`
- **AND** every displaced participant appears on `ccRecipients` alongside Graph's existing Cc

#### Scenario: a caller addressed on To is not also demoted to Cc (issue #164)
- **WHEN** one of Graph's auto-populated To recipients matches a caller `to` entry, differing only in case
- **THEN** that address stays on To and is absent from `ccRecipients`

#### Scenario: replyAll false does not demote the displaced sender to Cc (issue #164)
- **WHEN** a reply draft is created with `replyAll: false` and an explicit `to`
- **THEN** the PATCH has no `ccRecipients` property — the parent's sender is deliberately dropped

#### Scenario: omitted to leaves toRecipients out of the PATCH (issue #164 no-op guard)
- **WHEN** a reply draft is created with a `cc` but no `to`
- **THEN** the PATCH body has no `toRecipients` property at all

#### Scenario: empty to array leaves toRecipients out of the PATCH (issue #164)
- **WHEN** a reply draft is created with `to: []`
- **THEN** the PATCH body has no `toRecipients` property at all

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

The system SHALL enforce an email body maximum of 3.5MB (Graph allows ~4MB; the remainder is headroom for the JSON envelope), an attachment maximum of 25MB, and a subject maximum of 255 characters.

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
