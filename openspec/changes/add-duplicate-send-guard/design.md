## Context

`isRetryable(err, 'delivery') === false` and the single-attempt dispatch in the three
delivery actions make the *library* safe. The residual risk is entirely above that
line: a caller that re-issues the same tool call.

This design adds the missing state — a record that a given delivery was attempted —
and makes the delivery actions consult it.

## Goals / Non-Goals

**Goals**
- A second identical delivery call within the window does not reach the provider.
- A resend after a *proven* rejection is not blocked.
- A human can override deliberately.
- On by default, no embedder wiring.

**Non-Goals**
- Surviving a process restart. (See the limitation in the proposal.)
- Cross-mailbox or cross-tenant deduplication.
- Detecting near-duplicates. The fingerprint is exact by construction; a body that
  differs by one character is a different message and is allowed through.

## Decisions

### Decision: fingerprint the delivery, not the call

Keying on a caller-supplied idempotency key was rejected: it pushes the burden onto
the caller we are defending against, and an agent that replays a call replays the key
too — which would work — but an agent that *forgets* to send one gets no protection at
all. Fingerprinting the delivery content means protection is automatic and a replay is
detected whether or not the caller cooperates.

The fingerprint covers everything that determines what the recipient receives:
mailbox, action name, normalized `to`/`cc`, subject, the rendered body and bodyHtml
(post-truncation, so the fingerprint matches the bytes that would go out), attachment
name/size/content digests, `scheduled_send_at`, and the reply parent id / draft id.

Attachment *content* is digested rather than compared, so the ledger never holds
message bytes.

### Decision: three states, not a boolean

`in-flight` / `delivered` / `unresolved` are distinguished because the caller's next
move differs: wait, stop (here is the id), or escalate to a human who can look in
Sent Items. Collapsing them to one "duplicate" code would force the agent to guess.

### Decision: fail closed on unknown outcome codes

Only an explicit allowlist of codes releases the fingerprint —
`RATE_LIMITED`, `INVALID_REQUEST`, `AUTH_REQUIRED`, `PERMISSION_DENIED`, `NOT_FOUND`,
`CONFLICT`, `PAYLOAD_TOO_LARGE`, `PROVIDER_REJECTED`, `PROVIDER_UNREACHABLE`,
`SCHEDULE_SEND_FAILED`, `NOT_SUPPORTED`. These are exactly the outcomes the existing
`classifyHttpStatus` reasoning already proves did not deliver: a 4xx proves receipt
and rejection; a connect-failure proves no bytes were written.

Every other code, including one this version has never seen from a third-party
provider, holds the fingerprint as `unresolved`. The asymmetry is intentional. A false
hold costs friction and has an override; a false release costs a duplicate in
someone's inbox, which is the bug being fixed.

### Decision: default-on singleton, injectable for tests

`ActionContext.sendLedger` is optional, but when absent the actions use a module-level
default rather than skipping the guard. `ActionContext.rateLimiter` is the cautionary
example: it is an optional interface that no shipped adapter constructs, so the rate
limit it describes does not exist in the product. An optional guard is not a guard.

Tests inject a fresh `SendLedger` (and `resetDefaultSendLedger()` exists for suites
that exercise the default path) so cases stay independent.

### Decision: claim before dispatch, settle after

The claim is written *before* the provider call, not after, so the in-flight window —
the exact window in which the acknowledgement gets lost — is covered. A settle
records the terminal state; a release removes the record.

If the action throws between claim and settle, the record stays `in-flight` until its
TTL expires and then becomes claimable again. Holding rather than releasing is the
fail-closed direction: a throw after dispatch is precisely the ambiguous case.

## Risks / Trade-offs

- **Legitimate identical resends inside the window are blocked.** Mitigated by
  `allow_duplicate`, by the 15-minute default, and by the error message naming the
  flag. Repeated identical automated mail (a status ping) is normally further apart
  than the window; an operator who disagrees can set the window to `0`.
- **Memory growth.** Bounded: entries are pruned by TTL on every access and the map is
  capped at 512 records, evicting oldest-first.
- **A restart clears the ledger.** Documented rather than papered over.
