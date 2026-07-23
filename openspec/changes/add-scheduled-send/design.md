## Context

The #61 spike established the constraints that mocks could not:

- `POST /sendMail` is not suitable because it can discard extended properties.
- Creating a draft with `SystemTime 0x3FEF`, then posting `/messages/{id}/send`, leaves the item provider-held in Drafts until the scheduled time.
- The held draft remains directly addressable and deletable before delivery.
- Exchange delivers after the client exits.
- The original draft id becomes invalid after delivery and the Sent Items copy has a new id.
- `sentDateTime` reflects the original send call, not the deferred delivery time.

## Decision: optional scheduling capability

Add `EmailScheduledSender` with:

- `scheduleMessage(message, scheduledSendAt)`
- `scheduleDraft(draftId, scheduledSendAt)`
- `cancelScheduledSend(messageId)`
- `listScheduledSends()`

`EmailProvider` includes this interface through `Partial<>`. This keeps `EmailSender` stable for downstream providers and lets actions return `NOT_SUPPORTED` without transport-layer provider checks. Microsoft implements the capability; Gmail intentionally does not.

## Decision: provider-held handles

The scheduled-send handle is named `messageId` and is the held provider item id. On Graph this is the draft id returned by `POST /messages`. It is guaranteed only while the item is pending. The list and cancel actions operate on that same handle.

No attempt is made in v1 to reconcile the post-delivery Sent Items id. Doing so safely requires another stable correlation contract (for example an Internet Message-ID or tracking property lookup), and the spike proved `sentDateTime` is not a trustworthy delivery-time signal.

## Decision: validation and normalization in email-core

`scheduled_send_at` is represented at the tool boundary by a Zod string schema annotated as the JSON Schema `date-time` format. Email-core performs the authoritative semantic validation because actions are public and tests/downstream callers may invoke `run()` directly; this also lets MCP calls receive the same structured action error instead of a transport-level Zod error.

The validator:

- requires an explicit timezone (`Z` or numeric offset);
- rejects invalid dates;
- rejects timestamps that are not in the future;
- normalizes accepted values with `Date#toISOString()` before provider dispatch.

This keeps Graph payloads UTC and makes equivalent offset timestamps deterministic.

## Decision: cancellation fails closed

Graph cancellation first fetches the candidate with:

- `isDraft`;
- the deferred-send extended property filtered to `SystemTime 0x3FEF`.

It deletes only when the item is still a draft and the property is present. A missing property returns `NOT_SCHEDULED`; a delivered/missing item returns a structured failure. This tool therefore cannot bypass the separate `delete_email` policy to delete arbitrary messages.

## Decision: listing is Drafts-scoped and bounded

Microsoft pages through Drafts in batches of 100 with an `$expand` filtered to the deferred property, then filters client-side to rows that actually contain the property. A 100-page/loop guard fails explicitly instead of silently returning an incomplete result. This avoids an unsupported assumption about server-side filtering by legacy proptag while keeping the request bounded.

Returned rows include `messageId`, `subject`, recipient strings, and the normalized `scheduledSendAt`. Only pending held items in Drafts are represented.

## Failure semantics

Scheduling is a two-write operation. If draft creation succeeds but Graph explicitly rejects `/send` with a 4xx response, the provider returns a non-recoverable `SCHEDULE_SEND_FAILED` with the created `messageId`. If the response is lost or Graph returns a server-side failure, submission status is ambiguous: the provider returns non-recoverable `SCHEDULE_SEND_STATUS_UNKNOWN`, warns that delivery may already be scheduled, and directs the caller to inspect or cancel the retained handle rather than create a duplicate. The action never automatically retries the whole two-step operation.
