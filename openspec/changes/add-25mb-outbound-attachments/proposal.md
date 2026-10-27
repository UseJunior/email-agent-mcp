# Change: Support 25 MB outbound attachments end to end

## Why

The action layer accepts individual attachments up to 25 MB, but Microsoft Graph's inline attachment requests fail near 3 MB and Gmail's JSON raw-message path is unsuitable above 5 MB. The documented limit therefore is not reliable for real sends and drafts.

## What Changes

- Keep one authoritative 25 MB per-attachment validation limit with a clear `ATTACHMENT_TOO_LARGE` failure above it.
- Use Microsoft Graph attachment upload sessions with chunked PUTs whenever an attachment cannot use the small inline request path.
- Use Gmail raw MIME media uploads (multipart upload) for messages over 5 MB.
- Apply the provider upload strategy to direct sends, replies, draft creation, draft replacement, and scheduled-send draft creation.
- Update provider documentation and tests to describe and verify the supported limit.

## Impact

- Affected specs: `email-attachments`, `provider-microsoft`, `provider-gmail`
- Affected code: email action attachment validation, Microsoft Graph provider/client, Gmail googleapis client, provider docs and tests
