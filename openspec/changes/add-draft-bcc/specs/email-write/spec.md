## ADDED Requirements

### Requirement: Draft Bcc Recipients

`create_draft` and `update_draft` SHALL accept an optional `bcc` list of recipient addresses, in bare or name-address form, and SHALL forward it to the provider: Microsoft Graph as `bccRecipients`, Gmail as a `Bcc` header. Body-file frontmatter SHALL recognize a `bcc` key with the same comma-separated form as `to` and `cc`, and it SHALL override the `bcc` parameter like other frontmatter keys.

On the reply path, providers SHALL remove every Bcc address from the To and Cc they derive from the parent message, so a thread participant can be moved to Bcc without restating the rest of the audience. A message whose To becomes empty this way SHALL be composed without a To line rather than with an empty one.

An address listed on `bcc` and on `to` or `cc` in the same call SHALL be rejected with `BCC_RECIPIENT_CONFLICT`. When the persisted draft read back for the preview still lists a Bcc address on To or Cc, the response SHALL include a `BCC_RECIPIENT_ALSO_VISIBLE` warning.

On `update_draft`, a supplied `bcc` SHALL replace the draft's Bcc line, an empty list SHALL clear it, and an omitted `bcc` SHALL leave it unchanged. The draft preview SHALL report the persisted Bcc recipients.

`send_email` has no Bcc support; when its body-file frontmatter sets `bcc`, it SHALL fail with `BCC_NOT_SUPPORTED` and send nothing.

Drafts remain allowlist-exempt. `send_draft` SHALL continue to gate the stored draft's Bcc recipients against the send allowlist exactly like its To and Cc.

#### Scenario: New draft with bcc
- **WHEN** `create_draft` is called with `{to: "alice@allowed.com", bcc: ["Audit Desk <audit@allowed.com>"], subject, body}`
- **THEN** the provider's `createDraft` receives the parsed Bcc recipient with its display name, and `preview.bcc` reports it

#### Scenario: Omitted bcc sends no bcc to the provider
- **WHEN** `create_draft` is called without `bcc`
- **THEN** the provider's `createDraft` receives no `bcc`

#### Scenario: Reply-all draft moves the introducer to bcc
- **WHEN** `create_draft` is called with `{reply_to: "<introduction message>", to: "bob@allowed.com", bcc: ["introducer@allowed.com"], body}`
- **THEN** the provider's reply-draft call receives the Bcc recipient, and the draft is addressed to Bob with the introducer only on Bcc

#### Scenario: Reply draft bcc removes the address from the derived recipients
- **WHEN** `create_draft` is called with `reply_to`, `reply_all: false`, no `to`, and `bcc` naming the parent's sender in different letter case
- **THEN** the sender is absent from the draft's To and present on its Bcc

#### Scenario: Bcc address also listed on to or cc is rejected
- **WHEN** `create_draft` is called with an address on both `cc` and `bcc`, compared case-insensitively
- **THEN** the call fails with `BCC_RECIPIENT_CONFLICT` and no draft is created

#### Scenario: Invalid bcc address is rejected
- **WHEN** `create_draft` is called with a `bcc` entry that is not a valid address
- **THEN** the call fails with `INVALID_ADDRESS` naming `bcc[0]`

#### Scenario: Bcc from body_file frontmatter
- **WHEN** a `.md` body file declares `bcc: audit@allowed.com, legal@allowed.com`
- **THEN** `create_draft` stores both addresses on Bcc

#### Scenario: send_email refuses bcc frontmatter instead of dropping it
- **WHEN** `send_email` is called with a body file whose frontmatter sets `bcc`
- **THEN** the call fails with `BCC_NOT_SUPPORTED` and nothing is sent

#### Scenario: update_draft sets, keeps, and clears bcc
- **WHEN** `update_draft` is called with `bcc`, then with only `subject`, then with `bcc: []`
- **THEN** the draft's Bcc is set, then preserved, then cleared

#### Scenario: update_draft warns when a bcc recipient is still on to or cc
- **WHEN** `update_draft` sets `bcc` to an address the draft already lists on Cc, without restating `cc`
- **THEN** the update succeeds and returns a `BCC_RECIPIENT_ALSO_VISIBLE` warning naming the address

#### Scenario: update_draft rejects a bcc that conflicts with to or cc in the same call
- **WHEN** `update_draft` is called with the same address on `to` and `bcc`
- **THEN** the call fails with `BCC_RECIPIENT_CONFLICT`

#### Scenario: send_draft blocks a draft whose bcc set via create_draft is not allowlisted
- **WHEN** a draft is created with an allowlisted To and a Bcc outside the allowlist, and `send_draft` is called on it
- **THEN** `send_draft` returns `ALLOWLIST_BLOCKED` and nothing is sent

#### Scenario: send_draft blocks a reply draft whose bcc set via update_draft is not allowlisted
- **WHEN** a reply draft is given a Bcc outside the allowlist through `update_draft`, and `send_draft` is called on it
- **THEN** `send_draft` returns `ALLOWLIST_BLOCKED` and nothing is sent
