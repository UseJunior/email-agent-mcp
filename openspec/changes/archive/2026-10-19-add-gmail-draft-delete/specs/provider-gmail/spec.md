## ADDED Requirements

### Requirement: Draft-Only Deletion

The Gmail provider SHALL implement `deleteMessage` for drafts only, using `users.drafts.delete`, which the default `gmail.compose` scope authorizes. It SHALL accept either a draft id or the id of the draft's message, resolving a message id to its draft id through `users.drafts.list` across every page. A Gmail draft delete SHALL be permanent regardless of `hard_delete`, because Gmail has no trash for drafts, and SHALL NOT call any `gmail.modify` endpoint.

A message that exists but is not a draft SHALL be refused with a non-recoverable `NOT_SUPPORTED` error stating that only drafts can be deleted with the current scopes and that sent or received mail would need `gmail.modify`. An id that names nothing, or a DRAFT-labelled message absent from `drafts.list`, SHALL raise `MessageNotFoundError`; so SHALL a non-draft id on a client without `drafts.list`, which can resolve only draft ids. A `drafts.delete` 404 for a draft that resolved immediately before SHALL count as a successful delete, because the draft is already gone (for example after the client retried a DELETE whose first attempt succeeded). Other `drafts.delete` failures SHALL be classified as Gmail provider errors. A Gmail client without draft deletion SHALL report `NOT_SUPPORTED`.

A Gmail draft delete SHALL remain behind the existing delete policy: it requires `AGENT_EMAIL_DELETE_ENABLED=true` and `user_explicitly_requested_deletion: true`, and a caller-supplied `hard_delete: true` still requires `AGENT_EMAIL_HARD_DELETE_ENABLED=true`. It SHALL NOT otherwise require the hard-delete gate.

#### Scenario: Delete a Gmail draft by draft id
- **WHEN** `deleteMessage` is called with a draft id
- **THEN** the provider calls `drafts.delete` with that id without listing drafts

#### Scenario: Delete a Gmail draft by its message id
- **WHEN** `deleteMessage` is called with the id of a DRAFT-labelled message
- **THEN** the provider finds the matching draft in `drafts.list` and calls `drafts.delete` with its draft id

#### Scenario: Draft id resolution follows drafts.list pagination
- **WHEN** the matching draft is on a later `drafts.list` page
- **THEN** the provider follows `nextPageToken` until it finds the draft

#### Scenario: Deleting sent or received Gmail mail is not supported
- **WHEN** `deleteMessage` is called with the id of a message without the DRAFT label
- **THEN** it fails with `NOT_SUPPORTED` naming `gmail.modify`, and no delete or modify request is made

#### Scenario: Deleting an unknown Gmail id reports not found
- **WHEN** the id names neither a draft nor a message
- **THEN** `deleteMessage` raises `MessageNotFoundError`

#### Scenario: A DRAFT-labelled message missing from drafts.list reports not found
- **WHEN** the message carries the DRAFT label but no draft in `drafts.list` points at it
- **THEN** `deleteMessage` raises `MessageNotFoundError` and deletes nothing

#### Scenario: Gmail draft delete ignores hard and is always permanent
- **WHEN** `deleteMessage` is called with `hard: true`
- **THEN** the provider calls `drafts.delete` exactly as for a soft delete

#### Scenario: drafts.delete failures are classified as provider errors
- **WHEN** `drafts.delete` fails with an HTTP error
- **THEN** `deleteMessage` raises a Gmail `ProviderError`

#### Scenario: A drafts.delete 404 after resolution counts as deleted
- **WHEN** the draft resolves but `drafts.delete` returns 404
- **THEN** `deleteMessage` succeeds

#### Scenario: Gmail client without drafts.list resolves only draft ids
- **WHEN** the concrete Gmail client has no `listDrafts` and the id is not a draft id
- **THEN** `deleteMessage` raises `MessageNotFoundError` without reading the message

#### Scenario: Gmail client without drafts.delete reports NOT_SUPPORTED
- **WHEN** the concrete Gmail client has no `deleteDraft`
- **THEN** `deleteMessage` raises `NOT_SUPPORTED` before any request

#### Scenario: Gmail draft delete stays behind the delete policy gate
- **WHEN** `delete_email` targets a Gmail draft with deletion disabled, without caller intent, or with `hard_delete: true` but no hard-delete gate
- **THEN** it returns `DELETE_DISABLED` and deletes nothing
- **AND WHEN** only `AGENT_EMAIL_DELETE_ENABLED` and caller intent are present
- **THEN** the draft is deleted

#### Scenario: delete_email on Gmail sent mail returns NOT_SUPPORTED
- **WHEN** `delete_email` targets a sent Gmail message with deletion enabled
- **THEN** it returns `{success: false, error: {code: "NOT_SUPPORTED"}}` naming `gmail.modify`

#### Scenario: listDrafts maps draft ids to their message ids
- **WHEN** the googleapis client lists drafts
- **THEN** it returns each draft id with its message id and the next page token, skipping drafts without an id

#### Scenario: deleteDraft uses Gmail drafts.delete
- **WHEN** the googleapis client deletes a draft
- **THEN** it calls `users.drafts.delete` for `me` with the draft id

### Requirement: Draft Id Resolution

Gmail draft reads and edits SHALL accept the id of a draft's message as well as its draft id, using the same resolution as draft deletion, so a draft found through `list_emails(folder: "drafts")`, `read_email`, or `get_thread` can be edited by the id those tools report.

#### Scenario: update_draft accepts a Gmail draft message id
- **WHEN** `updateDraft` is called with a draft's message id
- **THEN** the provider resolves the draft id and calls `drafts.update` with it, preserving the existing body

#### Scenario: update_draft refuses a Gmail message that is not a draft
- **WHEN** `updateDraft` is called with the id of a sent message
- **THEN** it returns `NOT_A_DRAFT` and makes no update

#### Scenario: Draft reply status resolves a Gmail draft message id
- **WHEN** `getDraftReplyStatus` or `getDraft` is called with a draft's message id
- **THEN** it reads the resolved draft
