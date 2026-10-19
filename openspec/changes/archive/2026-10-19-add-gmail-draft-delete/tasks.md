# Tasks

## 1. Gmail provider
- [x] 1.1 Add `listDrafts` and `deleteDraft` to the Gmail client (`users.drafts.list`, `users.drafts.delete`).
- [x] 1.2 Resolve a draft from a draft id or its message id, following `drafts.list` pagination.
- [x] 1.3 Implement draft-only `deleteMessage`; refuse non-drafts with `NOT_SUPPORTED` naming `gmail.modify`.
- [x] 1.4 Use the same resolution in `getDraft`, `getDraftReplyStatus`, and `updateDraft`.

## 2. Core
- [x] 2.1 Return `delete_email` provider failures as structured errors.
- [x] 2.2 Describe Gmail behavior on `delete_email` and `update_draft` inputs.

## 3. Docs and verification
- [x] 3.1 Document draft-only Gmail deletion in the README.
- [x] 3.2 Provider (mocked client), googleapis client, and policy-gate tests.
- [x] 3.3 Run build, lint, tests, spec coverage, and strict OpenSpec validation.
