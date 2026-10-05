# Tasks

## 1. Sandboxed writer
- [x] 1.1 Resolve `save_to` against the shared multi-root sandbox; canonicalize the nearest existing ancestor and the final directory.
- [x] 1.2 Reject `..`, leading `~`, absolute paths outside every root, and symlink escapes before any download.
- [x] 1.3 Create files with `O_EXCL` (+ `O_NOFOLLOW`), mode 0600, deterministic collision suffixes, partial-file cleanup.
- [x] 1.4 Return size and SHA-256 of the exact bytes written.

## 2. Actions and providers
- [x] 2.1 Add `save_to` / `filename` to `download_attachment`; keep the inline response as default.
- [x] 2.2 Refuse oversized inline downloads with a `save_to` hint; 150 MB cap with `save_to`.
- [x] 2.3 Add `download_message` and optional provider `getRawMessage` (Graph `/$value`, Gmail `format=raw`).

## 3. Specification and verification
- [x] 3.1 Add requirements and scenarios.
- [x] 3.2 Tests for success, confinement, collisions, hashes, size limits, provider errors.
- [x] 3.3 Live smoke against a real mailbox (Graph and Gmail).
