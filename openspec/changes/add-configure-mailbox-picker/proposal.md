## Why

Returning users with multiple configured mailboxes must currently remember both
the provider and the mailbox alias when they run `email-agent-mcp configure`.
A bare interactive configure silently defaults to Microsoft, which can send the
user through the wrong authentication flow.

## What Changes

- Detect ambiguous interactive `configure` and `setup` invocations when more
  than one mailbox is configured.
- Present the configured mailboxes with email address, provider, exact alias,
  and last-authenticated date, plus an option to add a new mailbox.
- Reauthenticate a selected mailbox using its saved provider and exact alias.
- Send the add-new choice through the existing first-run provider wizard.
- Preserve direct flag-driven behavior whenever `--provider` or `--mailbox` is
  supplied, for all non-TTY callers, and for the NemoClaw setup variant.

## Impact

- Affected spec: `cli`
- Affected code: `packages/email-mcp/src/cli.ts`,
  `packages/email-mcp/src/wizard.ts`, and their tests
- User-visible behavior: ambiguous interactive configure commands gain one
  mailbox selection step; explicit and automated invocations are unchanged.
