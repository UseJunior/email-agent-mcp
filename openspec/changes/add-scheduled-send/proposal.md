## Why

Agents can send immediately or leave a draft, but they cannot ask the provider to deliver at a future time. Issue #61 needs a durable scheduled-send path that survives the MCP process exiting, remains allowlist-gated, and can be inspected or cancelled before delivery.

A live Microsoft 365 spike recorded on #61 verified the provider behavior before implementation: a draft carrying MAPI `PidTagDeferredSendTime` (`SystemTime 0x3FEF`) remains in Drafts after `/send`, survives client exit, can be deleted to cancel, and moves to Sent Items under a new Graph id at delivery. Gmail exposes no public scheduled-send API.

## What Changes

- Add optional `scheduled_send_at` to `send_email` and `send_draft`. It accepts an ISO 8601 timestamp with an explicit timezone, normalizes it to UTC, and rejects invalid or non-future values before any provider write.
- Add `cancel_scheduled_send(message_id)` and `list_scheduled_sends()` actions. Cancellation is destructive and verifies the deferred-send property before deleting, so it cannot become an alternate arbitrary-message deletion path.
- Add an optional `EmailScheduledSender` provider capability rather than putting provider-specific behavior in MCP or action adapters.
- Implement Microsoft scheduling as the spike-verified two-step draft → send flow using `SystemTime 0x3FEF`; never use `/sendMail` for deferred delivery.
- Keep immediate send behavior unchanged. Gmail and providers without the scheduling capability return a structured `NOT_SUPPORTED` error.
- Preserve the held Graph draft id as the scheduled-send handle and document that it is valid only before delivery; Graph changes the message id when the item moves to Sent Items.
- Expose the two new actions through the thin MCP adapter and document the expanded tool surface.

## Impact

- Affected specs: `email-write`, `provider-interface`, `provider-microsoft`, `provider-gmail`
- Affected code: email-core types/provider capability/actions; Microsoft provider Graph mapping and calls; Gmail unsupported behavior; MCP action imports; tests and tool documentation
- Security: scheduling remains send-allowlist and rate-limit gated. Cancellation verifies both `isDraft` and the deferred-send property before issuing Graph DELETE.
- Compatibility: all new input fields, provider methods, result fields, and actions are additive. Immediate sends and existing provider implementations remain source-compatible because scheduling is an optional capability.
- Operational caveat: the Microsoft mechanism is an undocumented composition of documented Graph extended-property APIs and the documented MAPI deferred-send property. The live spike is the behavioral oracle.
