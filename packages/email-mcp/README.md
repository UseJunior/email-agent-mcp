# MCP initialization

The initialization lifecycle implements group 7 of the approved
`harden-email-state-machines` OpenSpec design (Auth and initialization), tracked
by [#237](https://github.com/UseJunior/email-agent-mcp/issues/237) and parent
[#236](https://github.com/UseJunior/email-agent-mcp/issues/236).

Initialization has pending, connecting, ready, not_configured, and failed states.
Direct initialization and tool callers share the connecting promise. Results
publish as one snapshot only if their generation is still current. Explicit
configuration changes can call `resetProviderState` to invalidate pending work;
the next initialization call reads configuration again.

Microsoft mailboxes are attempted in discovery order, followed by Gmail in
discovery order. The first successful mailbox is the default. Connected
mailboxes precede failures in listings, preserving their respective attempt
orders. Partial success stays ready; failures remain visible in `list_mailboxes`
and `get_mailbox_status`.

When all mailboxes fail, recognized network/service failures can retry on a
subsequent tool call at least 30 seconds after failure. There is no retry timer.
Credential/consent failures and unclassified errors require configure and a
server restart (or an explicit state reset by an embedder). A transient retry
does not reauthenticate terminally failed siblings. A successful partial setup
and an empty configuration do not automatically reinitialize.

MCP tool schemas and status fields are unchanged: ready projects to `connected`,
failed to `error`, and mailbox failures to `status: "error"` with their error
text. MCP status stays non-blocking during authentication; an eligible status
call starts a retry and reports `connecting`. One-shot CLI diagnostics await
initialization to report the actual configuration, without requiring a healthy
mailbox. Initialization logs use stderr.

The exported `LazyProviderState` and `LazyMailboxState` shapes remain available
as deprecated compatibility interfaces. Factory-created states expose getters
over the internal union, including derived `isDemo`, `isDefault`, nullable
provider/auth fields, and `initPromise` (non-null while connecting). Mailbox
arrays are projection snapshots; mutating a snapshot does not change internal
selection. Assigning a top-level legacy field invalidates pending publication
and opts that state into the old mutable interface, including injected promises
and session-sticky errors. Plain legacy pending objects are adopted into the
new lifecycle when initialization begins. Production code should use
`createLazyProviderState`, `initProvider`/`waitForInit`, `ensureProvider`, and
`resetProviderState` instead of assigning legacy fields.

Regression coverage: `src/server-lifecycle.test.ts`, with existing wire and
compatibility tests in `src/server.test.ts` and CLI tests in `src/cli.test.ts`.
