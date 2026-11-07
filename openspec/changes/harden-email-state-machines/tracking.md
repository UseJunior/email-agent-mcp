# Finding and PR map

Parent: https://github.com/UseJunior/email-agent-mcp/issues/236

| Group | Finding issues | Depends on | Deliverable |
| --- | --- | --- | --- |
| 1 | #241 (SM-5) | proposal approval | broker transitions/expiry/claim |
| 2 | #248 (SM-12) | proposal approval | watcher lease |
| 3 | #247, #249, #254 (SM-11,13,19) | 2 | watcher polling/checkpoint/shutdown |
| 4 | #240 (SM-4) | proposal approval | Gmail auth |
| 5 | #238 (SM-2) | proposal approval | Microsoft delegated auth |
| 6 | #239 (SM-3) | proposal approval | Microsoft client-credentials auth |
| 7 | #237 (SM-1) | 4,5,6 | lazy initialization |
| 8 | #245 (SM-9) | proposal approval | draft snapshots |
| 9 | #246 (SM-10) | 8 | scheduling phases |
| 10 | #244 (SM-8) | proposal approval | delivery leases |
| 11 | #242, #243 (SM-6,7) | 4,5,6 | authenticated retries |
| 12 | #250 (SM-14), related #206 | proposal approval | allowlists |
| 13 | #251 (SM-15) | proposal approval | rate reservations |
| 14 | #108 (SM-16) | proposal approval | folder cache generations |
| 15 | #252 (SM-17) | proposal approval | subscription/cursor helpers |
| 16 | #253 (SM-18) | proposal approval | loopback OAuth |

SM-20: #255 is closed as not planned, with verified deferred rationale. No production code is implemented by this proposal.

Every implementation PR must reference the parent and finding issues. Preserve issue acceptance checklists; do not close an issue on a foundational types-only PR. Close only when behavior and tests are delivered. Do not auto-merge or deploy.

## Implementation review queue

The owner approved proposal #256 before implementation. All PRs below remain unmerged. Checkboxes stay incomplete until acceptance and review findings are reconciled; an open PR is not a completed issue.

| Group | Implementation PR | Status |
| --- | --- | --- |
| 1 | #260 | Implemented; Redis contract/CI coverage verified; final review |
| 2 | #257 | Implemented; mailbox-specific lease and release-review fixes |
| 3 | #263 | Implemented; raw Graph validation review fix underway |
| 4 | #261 | Implemented; rotation persistence review fix and CI passed |
| 5 | #264 | Implemented; lifecycle review passed |
| 6 | #265 | Implemented; lifecycle review and stacked CI passed |
| 7 | #270 | Implemented; serial workspace tests and stacked CI passed |
| 8 | #266 | Implemented; CI passed; final review |
| 9 | #268 | Implemented; stacked CI passed; final review |
| 10 | #271 | Implemented; alias and terminal lease tests; final review |
| 11 | #269 | Implemented; retry semantics tests and stacked CI passed |
| 12 | #267 | Implemented; deterministic allowlist tests and CI passed |
| 13 | pending | Reservation implementation underway |
| 14 | #258 | Implemented; redundant invalidation review fix verified |
| 15 | #262 | Implemented; Codex and Gemini dynamic reviews passed |
| 16 | #259 | Implemented; Codex and Gemini dynamic reviews passed |

Verification follow-up #272 / PR #273 replaces a preexisting stale hard-coded runtime tool count with exact registry identities. Both packed executable names passed the corrected smoke. No tool surface was added.

Integration is isolated on `integration/sm-state-hardening`, with auth dependency join `integration/sm-auth-foundation`. Required reconciliation includes watcher runner + typed fail-closed allowlist policy and independent cancellation for callers joining shared authentication flights. Main and existing user files are untouched. No auto-merge, deployment, archive, or issue closure is armed.
