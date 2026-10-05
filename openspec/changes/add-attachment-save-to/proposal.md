# Add Sandboxed Local-File Materialization for Downloads

## Why

`download_attachment` can only return bytes as inline base64. Agents that need
an attachment as a file (to hand to a PDF parser, video tool, or malware
scanner, or to keep a byte-exact record copy) must re-emit that base64 through
a write tool. That floods the context, risks silent corruption, and fails
outright for anything larger than a few hundred KB, such as a 13.8 MB screen
recording (#169). Record-keeping workflows also need the as-received `.eml`,
which today means bypassing the server's credentials and sandbox entirely.

## What Changes

- `download_attachment` accepts an optional `save_to` directory. The server
  writes the decoded bytes there and returns only
  `{path, filename, original_filename, mimeType, size, sha256}`.
- New `download_message` tool writes the raw RFC 822 message (Graph `/$value`,
  Gmail `format=raw`) to `save_to` as `.eml` with the same metadata.
- `save_to` resolves under the same sandbox as `body_file` and outbound
  `attachments[].path`: the safe directory plus `AGENT_EMAIL_ALLOWED_DIRS`
  roots (absolute paths for the latter). Traversal, a leading `~`, and symlink
  escapes are rejected. Missing subdirectories are created.
- Writes never overwrite: `O_EXCL` creation, deterministic `-N` suffixes on
  collision, mode `0600`, and partial files removed on failure.
- Inline downloads keep their default (5 MB) and ceiling (25 MB). An inline
  download over the cap returns `ATTACHMENT_TOO_LARGE` with a `save_to` hint.
  With `save_to` the default and ceiling are 150 MB.
- Providers gain an optional `getRawMessage`. Missing messages map to
  `MESSAGE_NOT_FOUND`.

## Impact

- Affected specs: `email-attachments`
- Affected code: `email-core` (new `content/save-file.ts`, attachment actions,
  provider interface, mock provider), `provider-microsoft` (`getBytes`,
  `getRawMessage`), `provider-gmail` (`format=raw`), README
