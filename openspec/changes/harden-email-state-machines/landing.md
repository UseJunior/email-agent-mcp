# Review and landing boundaries

Nothing is merged or deployed. PR-sized implementation remains separate from the combined verification branch. Do not merge `integration/sm-state-hardening` wholesale just because its CI passes.

## Dependency map

- Main-based independent PRs: #257 lease, #258 cache, #259 loopback callback, #260 broker, #261 Gmail auth, #262 provider helpers, #264 delegated auth, #266 snapshots, #267 allowlists, #273 runtime verification contract.
- Watcher stack: #257 → #263 (including raw message review fix aa3f4a7).
- Microsoft auth stack: #264 → #265.
- Delivery stack: #266 → #268 → #271 → #274.
- `integration/sm-auth-foundation` joins #261, #264/#265 and #257/#263. Its reconciliation commit 033b615 preserves delegated generation/serialization together with watcher cancellation signatures. #269 retry, #270 initialization and #276 shared-waiter cancellation are scoped against that join.
- #256 contains the approved proposal and this tracking material.

When landing is separately authorized, rebase/retarget stacked changes after their dependencies land and rerun checks. In particular, preserve the auth reconciliation and #276's independent waiter cancellation when moving join-based PRs onto main. Squash-merging dependencies does not make their original branch commits ancestors of main; do not assume an old triple-dot diff is the remaining patch.

## Combined verification snapshot

`integration/sm-state-hardening` at 5b2fb42 includes every implementation group, the raw-message and shared-cancellation review fixes, and these conflict resolutions:

- CLI watcher keeps the new runner/lease/shutdown pipeline while loading the typed allowlist policy and passing `.policy` to the actual sender gate. Invalid startup policy must not fall back to undefined configuration or accept-all defaults. The malformed-startup regression asserts no wake plus the new diagnostic, not the old aggregate poll log.
- Core send policy keeps both typed allowlist normalization and rate-reservation imports/behavior; security spec scenarios remain under their respective requirements.
- Graph imports and Microsoft spec requirements retain both authenticated retry and draft/scheduling changes.

The combined branch is the reference for these integration resolutions, not an authorization to bypass individual review or a new deployment artifact. If landing creates a different tree, rerun the combined acceptance and inspect these boundaries again.

## Acceptance evidence

Supervisor report: `/tmp/email-sm-integration-verification.md`. Full combined tests: `/tmp/email-sm-integration-final-tests.log`. The exact head passed 1,695 workspace tests (including real Redis), 36 script tests, build/lint, 422/422 scenario traceability, strict specs, manifest contracts and both packed executable smoke tests. CI: https://github.com/UseJunior/email-agent-mcp/actions/runs/42347022021 (passed).

Final independent review collection remains tracked in the parent issue. No real mailbox, live tenant, client draft, webhook deployment, production environment or release was mutated. Issues remain open pending landing; archive/deployment checklist items remain incomplete.
