# Gmail Draft-Only Deletion

## Why

`delete_email` cannot delete anything on a Gmail mailbox, even with `AGENT_EMAIL_DELETE_ENABLED=true`, because the Gmail provider implements no `deleteMessage` (issue #218). A superseded draft therefore cannot be removed once a replacement exists, and the fallback of stripping its recipients is unsafe: Gmail refills a reply draft's thread recipient, so a retired "SUPERSEDED - do not send" draft was sent to a customer. Google's `users.drafts.delete` accepts `gmail.compose`, so deleting a draft needs no new scope and no restricted-scope verification.

## What Changes

- The Gmail provider implements `deleteMessage` for drafts only. It accepts a draft id (`r…`) or the id of the draft's message, resolving the latter through `users.drafts.list`, and calls `users.drafts.delete`. The delete is permanent whatever `hard_delete` says, because Gmail has no trash for drafts.
- A sent or received Gmail message is refused with `NOT_SUPPORTED`, naming `gmail.modify` as the scope it would need. Agent Email still does not request `gmail.modify`.
- The policy gate is unchanged. A Gmail draft delete needs `AGENT_EMAIL_DELETE_ENABLED=true` and `user_explicitly_requested_deletion: true`, and does not need `AGENT_EMAIL_HARD_DELETE_ENABLED`: it is irreversible, but the draft was never sent.
- `update_draft` on Gmail accepts the draft's message id as well as its draft id, using the same resolution, so a draft created in the Gmail UI and found through `list_emails(folder: "drafts")` can be edited.
- `delete_email` returns provider failures as structured errors (`NOT_SUPPORTED`, `MESSAGE_NOT_FOUND`, `DELETE_FAILED`) instead of throwing.
- Out of scope: `send_draft` still requires the draft id, because its duplicate-send guard keys on the id the caller passes; a `retire_draft` helper is left for later.

## Impact

- Affected specs: `provider-gmail`, `email-categorize`
- Affected code: `provider-gmail` (provider, googleapis client, errors), `email-core` (`delete_email`, `update_draft` description), README
