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

For each HTTP request, from each route handler (`api/sessions`, `api/start`, `api/callback`, `api/tickets/claim`, `api/refresh`), the OAuth broker SHALL attempt to emit exactly one structured JSON log line. The attempt SHALL be made at most once per request; if the log sink itself fails (serialization or stdout write throws), the line MAY be dropped, and that failure SHALL NOT propagate into the request's control flow. Each line, when emitted, SHALL carry a `t` discriminator field with value `"broker_request"`, along with the request `route`, `method`, HTTP `status`, a coarse `outcome` label, `host`, `ua` (user-agent), a non-reversible session correlation id, and `dur_ms`.

The broker MAY write these lines to stdout (see the Log Destination requirement); they are captured as Vercel runtime logs. Logging SHALL NOT alter the OAuth flow, request/response contracts, or timing semantics of any route — which is why a failed log attempt is swallowed rather than allowed to abort a response.

This guarantee is a **provenance and schema** guarantee about the fields the broker itself derives and populates in the `broker_request` line: the broker SHALL NEVER read `code`, `state`, `access_token`, `refresh_token`, `client_secret`, the `Authorization` header, `pickup_secret`, `pickup_hash`, or a raw `session_id` and copy it into any log field, and SHALL NOT populate a client IP address. The broker achieves this by logging only a fixed enumerated field set — never the request URL, query object, headers map, or request/response body wholesale. A session identifier MAY appear only in a non-reversible form (a fixed truncation or hash prefix), never raw. The broker validates a session id's *syntax* (`ID_RE`), not its entropy; truncation is non-reversible for the first-party CLI, which supplies 256 bits of randomness, and the correlation field is a debugging aid, not a security boundary. Any URL that is ever logged SHALL first have its query string removed (OAuth callback URLs carry `code`/`state` there); the current handlers avoid this hazard entirely by logging a hardcoded `route` constant rather than the request URL.

The `host` and `ua` fields are an explicit exception to the scrubbing guarantee: they are **pass-through observability dimensions**, copied verbatim from client-controlled request headers and NOT sanitized. A caller can therefore place arbitrary text — including token-shaped strings — into its own `User-Agent`, and it will appear verbatim in the line. Downstream log consumers MUST treat `host`/`ua` as untrusted free text, never as a scrubbed surface. The provenance guarantee above is precisely that the broker does not itself lift OAuth secrets out of their real locations into the log; it is not a claim that a client cannot log-inject its own header values.

This scoping does NOT extend to the hosting platform's access logs. Vercel records the request path — including the query string — and may record the client IP, independently of the broker, exactly as the existing broker `README.md` already documents ("the `session_id` … lives in the browser URL, Google's `state` parameter, and the broker's access logs"). Platform access logs SHOULD therefore be treated as sensitive. The protocol is designed to blunt this: a successfully completed code exchange consumes the single-use authorization `code` (a code that never completes exchange is simply useless rather than reusable), and the `session_id` is deliberately non-secret — the `pickup_secret`, which never appears in any URL, is the actual credential.

#### Scenario: One line attempted per broker request
- **WHEN** any broker route handler completes a request and the log sink is healthy
- **THEN** exactly one JSON log line is emitted with `t: "broker_request"`, `route`, `method`, `status`, `outcome`, `host`, `ua`, a correlation id, and `dur_ms`

#### Scenario: A failing log sink never breaks the request
- **WHEN** emitting the log line would throw (serialization or stdout write fails)
- **THEN** the failure is swallowed and the line is dropped
- **AND** the OAuth response (status, body, and any one-shot ticket already consumed) is unaffected

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
