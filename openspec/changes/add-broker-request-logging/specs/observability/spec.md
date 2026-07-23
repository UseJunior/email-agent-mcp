## MODIFIED Requirements

### Requirement: Log Destination

The **MCP server** SHALL log exclusively to stderr. Logging to stdout from the MCP server SHALL be treated as a critical bug, because stdout is the MCP stdio transport and any write there corrupts the protocol.

This prohibition is scoped to the MCP server process. It does NOT apply to the OAuth broker (`apps/oauth-broker`), which is a separate standalone Vercel serverless deployment with no MCP stdio transport; broker logging is governed by the "Broker Request Logging" requirement below.

#### Scenario: MCP mode logging
- **WHEN** running as an MCP server (stdio transport)
- **THEN** all logs go to stderr in structured JSON format

#### Scenario: CLI mode logging
- **WHEN** running `watch` or `configure` (not as MCP child process)
- **THEN** logs go to stderr in human-readable format

#### Scenario: Broker logging is exempt from the stdout prohibition
- **WHEN** the OAuth broker emits a request log line
- **THEN** writing it to stdout is permitted, because the broker has no MCP stdio transport and Vercel captures stdout as a runtime log

## ADDED Requirements

### Requirement: Broker Request Logging

The OAuth broker SHALL emit exactly one structured JSON log line per HTTP request, from each route handler (`api/sessions`, `api/start`, `api/callback`, `api/tickets/claim`, `api/refresh`). Each line SHALL carry a `t` discriminator field with value `"broker_request"`, along with the request `route`, `method`, HTTP `status`, a coarse `outcome` label, `host`, `ua` (user-agent), a non-reversible session correlation id, and `dur_ms`.

The broker MAY write these lines to stdout (see the Log Destination requirement); they are captured as Vercel runtime logs. Logging SHALL NOT alter the OAuth flow, request/response contracts, or timing semantics of any route.

The broker SHALL NEVER log any of: `code`, `state`, `access_token`, `refresh_token`, `client_secret`, the `Authorization` header, `pickup_secret`, `pickup_hash`, or a raw `session_id`. The broker SHALL NOT log client IP addresses. Any URL that is logged SHALL have its query string removed first, because OAuth callback URLs carry `code` and `state` as query parameters. A session identifier MAY be logged only in a non-reversible form (a hash prefix or fixed truncation), never raw.

#### Scenario: One line per broker request
- **WHEN** any broker route handler completes a request
- **THEN** exactly one JSON log line is emitted with `t: "broker_request"`, `route`, `method`, `status`, `outcome`, `host`, `ua`, a correlation id, and `dur_ms`

#### Scenario: Sensitive OAuth material is never logged
- **WHEN** a request to `/api/callback` arrives with `code` and `state` query parameters, or a request to `/api/tickets/claim` carries a `pickup_secret`, or `/api/refresh` carries a `refresh_token`
- **THEN** the emitted log line contains none of `code`, `state`, `access_token`, `refresh_token`, `client_secret`, `pickup_secret`, `pickup_hash`, or a raw `session_id`
- **AND** any logged URL has had its query string stripped

#### Scenario: Session correlation without exposing the raw id
- **WHEN** a single OAuth flow moves through `/api/sessions` → `/api/start` → `/api/callback` → `/api/tickets/claim`
- **THEN** each line carries the same non-reversible correlation id derived from the session id
- **AND** the raw `session_id` value appears in no line

#### Scenario: Failure outcomes are distinguishable
- **WHEN** a broker request fails (e.g. an expired session, a denied consent, a failed code exchange, or an invalid pickup secret)
- **THEN** the log line's `outcome` field records the specific failure (such as `session_expired_or_unknown`, `denied`, `exchange_failed`, or `invalid_pickup_secret`)
- **AND** its `status` field records the HTTP status returned
