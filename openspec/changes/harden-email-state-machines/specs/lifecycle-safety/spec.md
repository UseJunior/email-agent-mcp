## ADDED Requirements

### Requirement: Serialized Authentication Transitions
Authentication managers SHALL own explicit session transitions, share concurrent refresh work, invalidate stale completions on disconnect, distinguish terminal reauthentication from transient failure, and preserve current provider credential-storage routes.

#### Scenario: Disconnect during refresh
- **WHEN** disconnect invalidates a session while token acquisition is pending
- **THEN** that acquisition SHALL NOT restore runtime credentials

#### Scenario: Gmail refresh rotation
- **WHEN** explicit refresh or an OAuth token event supplies a rotated refresh token
- **THEN** the current session and configured metadata writer SHALL receive the rotation without exposing broker refresh tokens through OAuth-client credentials

### Requirement: Coherent Provider Initialization
Provider initialization SHALL have one generation-checked transition owner and explicit connected/failed mailbox variants. It SHALL preserve startup default selection, expose partial failures, and allow transient retry after a 30-second cooldown.

#### Scenario: Late initialization completion
- **WHEN** an earlier initialization completes after a newer generation
- **THEN** its result SHALL NOT replace the current mailbox set

### Requirement: Explicit Draft And Scheduling Phases
Draft operations SHALL use snapshots with canonical IDs and independent lifecycle/origin. Unknown body origin SHALL remain fail-closed for replacement. Scheduling SHALL preserve IDs on partial failure and distinguish accepted, rejected and unknown dispatch. Ordinary editing/sending of verified pending scheduled drafts SHALL be refused. Cancellation SHALL require a valid future deferred marker.

#### Scenario: Ambiguous scheduled dispatch
- **WHEN** scheduling preparation succeeds but send acceptance cannot be determined
- **THEN** the result SHALL preserve the surviving ID and SHALL NOT automatically replay or delete it

#### Scenario: Deferred marker residue
- **WHEN** a candidate has a past or invalid deferred marker
- **THEN** cancellation SHALL refuse it as not verified pending

### Requirement: Delivery Lease Ownership
Delivery leases SHALL distinguish reserved, dispatched, settled and released. Release SHALL be legal only before dispatch, settlement SHALL be terminal, and dispatched attempts SHALL continue blocking until settled. Existing sibling-attempt identity, retention of settled records, explicit duplicate override and process-local scope SHALL remain.

#### Scenario: Dispatch outlasts retention
- **WHEN** an unsettled dispatched attempt exceeds the configured settled-record retention
- **THEN** an ordinary replay SHALL remain blocked

### Requirement: Atomic Rate Reservations
An injected limiter SHALL reserve capacity atomically and settle capacity according to proven rejection versus accepted/unknown delivery. Shipped adapters SHALL NOT gain a new default limiter.

#### Scenario: Concurrent callers at capacity
- **WHEN** concurrent calls compete for the final available reservation
- **THEN** at most one SHALL acquire it

### Requirement: Ordered Policy Reload
Allowlist loading SHALL distinguish absent, valid and invalid policies, validate string entries, serialize reloads and prevent completion after close. Absent defaults SHALL remain send-deny/receive-allow. Invalid startup policy SHALL block governed operations; invalid reload SHALL retain the last good policy.

#### Scenario: Stale reload completion
- **WHEN** policy changes while a prior load is outstanding
- **THEN** publication order SHALL NOT restore an older policy after the newer policy

### Requirement: Versioned Complete Cache Publication
Folder caches SHALL share concurrent loads and publish only complete snapshots from their current invalidation generation.

#### Scenario: Invalidation during traversal
- **WHEN** a folder mutation invalidates caches while traversal is pending
- **THEN** the pending traversal SHALL NOT repopulate the cache

### Requirement: Truthful Helper Outcomes
Subscription checks SHALL distinguish missing from unknown, with only 404 indicating missing. Cursor retrieval SHALL be bounded and SHALL advance only after complete retrieval. Loopback OAuth SHALL have exactly one terminal settlement and verify expected state before code exchange.

#### Scenario: Subscription transport failure
- **WHEN** checking a subscription fails with timeout, permission denial or server error
- **THEN** the helper SHALL return unknown or throw through its compatibility wrapper, not report missing

#### Scenario: Repeated cursor page
- **WHEN** a provider returns a repeated continuation token or URL
- **THEN** retrieval SHALL fail without publishing a new cursor
