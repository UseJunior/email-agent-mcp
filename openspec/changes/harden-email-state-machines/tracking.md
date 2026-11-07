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
