# Tasks

## 1. Reply draft validation
- [x] 1.1 Skip the required-`to` check when `create_draft` is given `reply_to`.
- [x] 1.2 Keep requiring `to` and `subject` for new drafts.
- [x] 1.3 Omit `to` from the provider reply-draft call when the caller supplied none.
- [x] 1.4 Preserve the explicit-`to` override on the reply path (issue #164).

## 2. Documentation
- [x] 2.1 Update the `create_draft` tool description and `to` parameter description.

## 3. Specification and verification
- [x] 3.1 Update the reply-draft requirements and scenarios.
- [x] 3.2 Add regression coverage for reply-all and sender-only replies without `to`, in core and both providers.
- [x] 3.3 Run tests, lint, build, and strict OpenSpec validation.
