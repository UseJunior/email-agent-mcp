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

The owner approved proposal #256 before implementation. All sixteen groups and both follow-ups are implemented, acceptance-tested and independently reviewed by Codex and Gemini. All PRs below remain unmerged; an implementation-ready PR is not a closed issue. Historical per-row milestones below culminate in the final sign-off that follows.

| Group | Implementation PR | Status |
| --- | --- | --- |
| 1 | #260 | Implemented; Redis contract/CI coverage verified; final review |
| 2 | #257 | Implemented; mailbox-specific lease and release-review fixes |
| 3 | #263 | Implemented; raw Graph validation review fix aa3f4a7, final review |
| 4 | #261 | Implemented; rotation persistence review fix and CI passed |
| 5 | #264 | Implemented; lifecycle review passed |
| 6 | #265 | Implemented; lifecycle review and stacked CI passed |
| 7 | #270 | Implemented; serial workspace tests and stacked CI passed |
| 8 | #266 | Implemented; CI passed; final review |
| 9 | #268 | Implemented; stacked CI passed; final review |
| 10 | #271 | Implemented; alias and terminal lease tests; final review |
| 11 | #269 | Implemented; retry semantics tests and stacked CI passed |
| 12 | #267 | Implemented; deterministic allowlist tests and CI passed |
| 13 | #274 | Implemented; 778 core tests, final review |
| 14 | #258 | Implemented; redundant invalidation review fix verified |
| 15 | #262 | Implemented; Codex and Gemini dynamic reviews passed |
| 16 | #259 | Implemented; Codex and Gemini dynamic reviews passed |

Verification follow-up #272 / PR #273 replaces a preexisting stale hard-coded runtime tool count with exact registry identities. Both packed executable names passed the corrected smoke. No tool surface was added.

Review follow-up #275 / PR #276 isolates shared delegated-auth waiter cancellation. Fourteen new overlap/cancellation cases and 542 affected tests passed before final integration; independent re-review remains gated.

## Final sign-off

All review findings were reconciled and all required reviews collected. Both families approve every implementation group, both follow-ups and integration glue. Complete local review index: `/tmp/email-sm-review-index.md`; acceptance report: `/tmp/email-sm-integration-verification.md`. Gemini's core client reached its deadline after eight scoped PASS verdicts; the preserved partial report plus a separate complete closeout include independent full-suite execution and explicit sign-off. No timeout alone was accepted as approval.

Final code snapshot `integration/sm-state-hardening` / `5b2fb42` passed 1,695 workspace tests including real Redis, 36 script tests, build/lint, 422/422 scenario traceability, strict specs/manifests and both packed executable entry points. CI run42347022021 passed all jobs including Node20/22, broker Redis and coverage. Separate frozen core review `42bd6d8` passed 1,680 tests before the 15 additional auth/raw-window regressions; those follow-ups were separately dual-reviewed on the final snapshot.

No merge, release, deployment, archive or live mailbox mutation occurred. Preserve the dependency/reconciliation boundaries in landing.md when landing is separately authorized. Finding issues remain open pending landing; #255 remains closed not planned.

Integration is isolated on `integration/sm-state-hardening`, with auth dependency join `integration/sm-auth-foundation`. Required reconciliation includes watcher runner + typed fail-closed allowlist policy and independent cancellation for callers joining shared authentication flights. Main and existing user files are untouched. No auto-merge, deployment, archive, or issue closure is armed.
