# Fix Reply Draft Subject Validation

## Why

`create_draft` requires `subject` when `reply_to` is supplied but never passes it to the provider. Callers must invent a subject even though providers correctly derive it from the parent message, risking broken threading.

## What Changes

- Require `subject` only for new drafts.
- Preserve provider-derived subjects for reply drafts, including when callers supply an unused subject.
- Keep the existing reply-draft recipient requirement unchanged.

## Impact

- Affected specs: `email-write`
- Affected code: `email-core` draft validation and tests
