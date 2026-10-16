# Tasks

## 1. Inputs
- [x] 1.1 Add `bcc` to `create_draft` and `update_draft` input schemas and pass it to `createDraft`, `createReplyDraft`, and `updateDraft`.
- [x] 1.2 Recognize `bcc` in body-file frontmatter; refuse it in `send_email`.
- [x] 1.3 Parse and validate bcc addresses; reject bcc/to/cc overlap in one call.

## 2. Providers
- [x] 2.1 Remove Bcc addresses from derived reply To/Cc in Gmail and Microsoft Graph.
- [x] 2.2 Omit an empty Gmail `To` header.

## 3. Read-back
- [x] 3.1 Warn when the persisted draft lists a Bcc address on To/Cc.

## 4. Verification
- [x] 4.1 Core, frontmatter, Gmail, and Graph tests, including `send_draft` allowlist gating of bcc set via `create_draft` and `update_draft`.
- [x] 4.2 Run build, lint, tests, and strict OpenSpec validation.
