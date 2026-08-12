## 1. Remove retry from delivery boundaries

- [x] 1.1 `send_email`: call `provider.sendMessage` exactly once; drop `withRetry`
- [x] 1.2 `reply_to_email`: call `provider.replyToMessage` exactly once; drop `withRetry`
- [x] 1.3 `send_draft`: call `provider.sendDraft` exactly once; drop `withRetry`
- [x] 1.4 Leave scheduled-send branches and non-delivery retry usage unchanged

## 2. Tests

- [x] 2.1 Single-dispatch tests: recoverable `ProviderError`, Graph-shaped thrown error, and plain `Error` each produce exactly one provider invocation across send, reply, and send_draft
- [x] 2.2 Deterministic Graph-shaped 400 returns a structured `SEND_FAILED` error fast (no backoff stall)
- [x] 2.3 Replace the prior "Transient error retry" expectation (3 attempts) with the single-attempt contract
- [x] 2.4 Full suite green
