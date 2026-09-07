## Why

`email-write` already forbids automatic retry of a delivery: the provider endpoints
carry no idempotency key, so the action layer dispatches exactly once and reports an
ambiguous outcome as `SEND_STATUS_UNKNOWN`. That closes the machine-retry hole. It
does not close the caller-replay hole.

The guarantee today is "the library will not retry," not "a replay cannot duplicate."
Nothing at the action layer stops the *caller* from re-issuing the identical send.
The only defence is a sentence of English in each tool description — "do not resend
without checking Sent Items" — and an LLM under retry pressure, or a supervisor loop
that lost the tool result mid-flight, is exactly the caller that skips it. The
failure is invisible when it happens: the second call succeeds, and the recipient
gets the message twice.

The concrete sequence: an agent calls `send_email`; the provider accepts; the
acknowledgement is lost (context compaction, transport drop, process supervisor
restart of the agent loop, a human retrying a "stuck" turn); the agent replays the
same approved instruction; a second message is delivered. No component in the
current design has the state to notice.

## What Changes

- Add a **send ledger**: an in-process, TTL-bounded record of delivery attempts keyed
  by a stable fingerprint of what would be delivered (mailbox, action, recipients,
  subject, rendered body, attachment digests, and for replies/drafts the parent
  message or draft id).
- Delivery actions (`send_email`, `reply_to_email`, `send_draft`) **claim** the
  fingerprint before dispatch and settle it after. A claim that collides with a live
  record short-circuits before the provider call and returns a structured error
  instead of delivering.
- Three outcomes are distinguished, because the recovery differs:
  `DUPLICATE_SEND_IN_FLIGHT` (a prior identical attempt has not returned),
  `DUPLICATE_SEND_BLOCKED` (a prior identical attempt was delivered — the prior
  `messageId` is returned), and `DUPLICATE_SEND_UNRESOLVED` (a prior identical
  attempt ended ambiguously, so Sent Items must be checked by a human).
- A failure that **proves** nothing was delivered (any 4xx-derived code, a 429, or a
  connect-failure) releases the fingerprint immediately: resending after a rejection
  is safe and must not be blocked. Anything else — including an unrecognised code —
  is held as unresolved. The guard fails closed.
- Add `allow_duplicate: true` to the three delivery actions as the deliberate escape
  hatch. The guard is a wall against machine replay and a speed bump for a human who
  has decided to send the same thing twice on purpose.
- The guard is **on by default**, with no wiring required by an embedder. This is
  deliberate: `ActionContext.rateLimiter` is an optional injected interface that no
  shipped adapter ever constructs, so it is inert in production. A duplicate-send
  guard that has to be opted into is a guard that is off.
- `AGENT_EMAIL_DUPLICATE_SEND_WINDOW_MS` tunes the retention window (default 15
  minutes); `0` disables the guard for operators who want the old behavior.

## Impact

- Affected specs: `email-write`
- Affected code: new `email-core/src/security/send-ledger.ts`; claim/settle wiring in
  `actions/send.ts`, `actions/reply.ts`, `actions/draft.ts`; `ActionContext` gains an
  optional `sendLedger`; new input field and error codes on three action schemas;
  `index.ts` exports; tool descriptions.
- Compatibility: additive. The new input field is optional and the new error codes are
  only reachable on a second identical call within the window, which previously
  delivered a duplicate.
- Security: the ledger stores a salted digest of message content, never the content
  itself, and never leaves the process.
- **Documented limitation:** the ledger is per-process and in-memory, so it does not
  survive an MCP server restart. It closes the replay window that actually occurs —
  the agent loop retrying inside a live server — and does not claim to close a
  crash-and-restart window. Cross-process durability would need a persisted store and
  is deliberately out of scope here.
