# Implementation groups

All boxes remain incomplete until implementation and acceptance tests pass. Parent: #236. PRs stay unmerged unless separately authorized.

- [ ] 0. Obtain approval of this concrete proposal; reconcile any requested changes before code.
- [ ] 1. Broker atomic session transitions, TTL preservation and memory/KV parity; include real disposable Redis tests.
- [ ] 2. Watcher MailboxLease, legacy lock detection and child-process exclusion tests.
- [ ] 3. After 2: watcher pagination/fixed windows, checkpoint migration and atomic writes, namespaced dedup, cancellation/drain/backoff.
- [ ] 4. Gmail auth union, generation/single-flight, rotation persistence, token-event synchronization, profile token acquisition.
- [ ] 5. Microsoft delegated auth union, generation/single-flight, silent reconnect and persistence failure tests.
- [ ] 6. Microsoft client credentials union, refresh single-flight, disconnect barriers.
- [ ] 7. After 4–6: initialization/mailbox unions, explicit default identity, cooldown retry and status compatibility.
- [ ] 8. Draft snapshots and shared eligibility, canonical IDs, origin safeguards and partial-failure results.
- [ ] 9. After 8: scheduling phases, partial preparation/unknown outcomes, pending-schedule mutation guards and cancellation validation.
- [ ] 10. Delivery leases, terminal settlement and active-dispatch retention; update action call sites.
- [ ] 11. After 4–6: authenticated retry operation semantics, safe deprecated auto-refresh, abortable waits and validation.
- [ ] 12. Allowlist lifecycle/policy union, serialized reload, validation and deterministic #206 deletion tests.
- [ ] 13. Atomic rate reservations, action integration and deprecated exported adapter; preserve unconfigured default.
- [ ] 14. Folder cache single-flight/generation and complete-only publication; resolve #108.
- [ ] 15. Subscription health tri-state, expiration/dedup/cursor bounds and truthful renewal documentation.
- [ ] 16. OAuth callback settlement owner, cleanup and expected-state validation.
- [ ] 17. At each PR: link findings, update parent checklist, run focused tests/build; close findings only once all acceptance criteria pass.
- [ ] 18. Integration: workspace tests/build/lint, spec coverage, manifests and isolated runtime; record synthetic provider smoke outcomes where applicable.
- [ ] 19. Update current specs and archive only after completed implementation is deployed under separate authorization.
