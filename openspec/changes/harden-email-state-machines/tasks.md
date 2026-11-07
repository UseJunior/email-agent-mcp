# Implementation groups

Implementation and acceptance gates below passed on the combined reviewed snapshot; archive/deployment remains separately gated. Parent: #236. PRs stay unmerged and issues stay open until separately authorized landing. Evidence and scope limitations are recorded in tracking.md and landing.md.

- [x] 0. Obtain approval of this concrete proposal; reconcile any requested changes before code.
- [x] 1. Broker atomic session transitions, TTL preservation and memory/KV parity; include real disposable Redis tests.
- [x] 2. Watcher MailboxLease, legacy lock detection and child-process exclusion tests.
- [x] 3. After 2: watcher pagination/fixed windows, checkpoint migration and atomic writes, namespaced dedup, cancellation/drain/backoff.
- [x] 4. Gmail auth union, generation/single-flight, rotation persistence, token-event synchronization, profile token acquisition.
- [x] 5. Microsoft delegated auth union, generation/single-flight, silent reconnect and persistence failure tests.
- [x] 6. Microsoft client credentials union, refresh single-flight, disconnect barriers.
- [x] 7. After 4–6: initialization/mailbox unions, explicit default identity, cooldown retry and status compatibility.
- [x] 8. Draft snapshots and shared eligibility, canonical IDs, origin safeguards and partial-failure results.
- [x] 9. After 8: scheduling phases, partial preparation/unknown outcomes, pending-schedule mutation guards and cancellation validation.
- [x] 10. Delivery leases, terminal settlement and active-dispatch retention; update action call sites.
- [x] 11. After 4–6: authenticated retry operation semantics, safe deprecated auto-refresh, abortable waits and validation.
- [x] 12. Allowlist lifecycle/policy union, serialized reload, validation and deterministic #206 deletion tests.
- [x] 13. Atomic rate reservations, action integration and deprecated exported adapter; preserve unconfigured default.
- [x] 14. Folder cache single-flight/generation and complete-only publication; resolve #108.
- [x] 15. Subscription health tri-state, expiration/dedup/cursor bounds and truthful renewal documentation.
- [x] 16. OAuth callback settlement owner, cleanup and expected-state validation.
- [x] 17. At each PR: link findings, update parent checklist, run focused tests/build; close findings only once all acceptance criteria pass.
- [x] 18. Integration: workspace tests/build/lint, spec coverage, manifests and isolated runtime; record synthetic provider smoke outcomes where applicable.
- [ ] 19. Update current specs and archive only after completed implementation is deployed under separate authorization.
