## 1. Ledger

- [x] 1.1 Add `packages/email-core/src/security/send-ledger.ts`: fingerprint builder, `SendLedger` class (claim/settle/release, TTL + size pruning), default singleton, and the `duplicateSendError` builder
- [x] 1.2 Add `send-ledger.test.ts` covering claim collision per state, release on proven-unsent codes, fail-closed on unknown codes, TTL expiry, and size eviction

## 2. Wiring

- [x] 2.1 Add optional `sendLedger` to `ActionContext`
- [x] 2.2 Claim/settle `send_email` (immediate and scheduled paths)
- [x] 2.3 Claim/settle `reply_to_email` (send path only — the draft path delivers nothing)
- [x] 2.4 Claim/settle `send_draft` (immediate and scheduled paths)
- [x] 2.5 Add `allow_duplicate` input and the three duplicate error codes to the three action schemas
- [x] 2.6 Update the three tool descriptions
- [x] 2.7 Export the ledger surface from `email-core/src/index.ts`

## 3. Tests

- [x] 3.1 Action-level scenario tests: replay blocked after delivery, after ambiguous outcome, and while in flight
- [x] 3.2 Action-level scenario tests: resend allowed after a proven rejection, and under `allow_duplicate`
- [x] 3.3 Negative control: the guard must be able to fail — a test that a *different* message is not blocked

## 4. Docs and gates

- [x] 4.1 Document `AGENT_EMAIL_DUPLICATE_SEND_WINDOW_MS` in README
- [x] 4.2 `npm run build`, `npm run lint --workspaces --if-present`, `npm run test:run`, `npm run check:spec-coverage`
