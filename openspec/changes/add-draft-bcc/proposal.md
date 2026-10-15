# Add Bcc Recipients to Draft Tools

## Why

`create_draft` and `update_draft` have no `bcc` input, and `bcc` is not a recognized body-file frontmatter key, so a caller cannot stage a draft with a Bcc recipient (issue #214). The common case is replying to an introduction and moving the introducer to Bcc ("moving you to bcc"). `ComposeMessage`, `ReplyOptions`, both providers, the draft preview, and the `send_draft` allowlist gate already carry bcc; only the tool input surface is missing it.

## What Changes

- `create_draft` and `update_draft` accept `bcc: string[]` (name-address form allowed), on new drafts and on the reply path. Microsoft Graph writes `bccRecipients`; Gmail writes a `Bcc` header.
- On the reply path, providers remove Bcc addresses from the To/Cc they derive from the parent, so a thread participant moves to Bcc without restating the audience. Gmail omits the `To` header when nobody is left on it.
- An address listed on both `bcc` and `to`/`cc` in the same call is rejected with `BCC_RECIPIENT_CONFLICT`. When the persisted draft still lists a Bcc address on To/Cc (e.g. `update_draft` set only `bcc`), the response carries a `BCC_RECIPIENT_ALSO_VISIBLE` warning.
- `update_draft` `bcc` replaces the draft's Bcc line; `[]` clears it; omitting it keeps it.
- Body-file frontmatter recognizes `bcc`. `send_email`, which has no bcc support, refuses a body file that sets it (`BCC_NOT_SUPPORTED`) instead of silently sending without the Bcc.
- No change to `send_draft`: it already gates bcc against the send allowlist.

## Impact

- Affected specs: `email-write`
- Affected code: `email-core` (draft/send actions, compose helpers, frontmatter, mock provider), `provider-gmail` and `provider-microsoft` reply-draft recipient resolution
