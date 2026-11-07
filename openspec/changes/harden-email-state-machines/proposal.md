# Change: Harden email state machines

## Why

Parent issue: https://github.com/UseJunior/email-agent-mcp/issues/236.

The state-machine audit found concrete concurrency and data-loss bugs, including non-atomic broker terminal transitions, first-page-only watcher polling, non-exclusive watcher lock acquisition, and stale cache publication. Other findings concern exported interfaces or remote races and need narrower guarantees than the original audit asserted. Individual issues record those distinctions.

## What Changes

- Introduce exhaustive lifecycle types and transition owners for auth, initialization, draft mutation, scheduling, watcher execution, policy reload, and delivery leases.
- Atomically advance/consume broker sessions without extending expiry.
- Make watcher ownership exclusive; paginate fixed polling windows; validate, migrate and atomically persist timestamp checkpoints; drain before releasing ownership.
- Serialize credential changes and policy/cache reloads, rejecting stale completions.
- Preserve current MCP tools and wire fields; add compatibility adapters for changed exported APIs.
- Explicitly retain process-local send deduplication and at-least-once wake delivery.
- Correct subscription helper claims without building a new renewal service.

## Impact

Affected capabilities: provider-gmail, provider-interface, email-watcher, plus the new cross-cutting lifecycle-safety capability. Affected workspaces: email-core, provider-gmail, provider-microsoft, email-mcp, oauth-broker. Existing provider metadata and legacy watcher timestamp checkpoints remain readable. Default startup mailbox selection, first-run start-now behavior, send/receive absent-file defaults, broker/BYOK isolation, and conservative unknown-delivery handling remain.

Intentional behavior changes: invalid existing watcher checkpoints stop that mailbox; malformed startup allowlists block governed operations; pending scheduled drafts reject ordinary mutation; initialization transient failures retry after cooldown; dispatched ledger leases do not expire before settlement. These changes require approval before implementation.

## Approval and delivery

This is a proposal-only PR. The user authorized implementation of the plan, but repository instructions require approval of the concrete OpenSpec proposal before architecture/security-pattern changes. Approval of this proposal authorizes the implementation groups and behavior changes described here. No auto-merge or deployment is included.

Implement in the 16 PR-sized groups in tasks.md. Link every PR from its finding issue and the parent; use closing references only after all issue acceptance criteria pass. SM-20 is deferred with source-backed disposition; existing #108 is reused for SM-16, and #206 stays linked to allowlist regression coverage.
