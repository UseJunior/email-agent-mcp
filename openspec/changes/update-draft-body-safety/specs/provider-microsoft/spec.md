## MODIFIED Requirements

### Requirement: Draft-Then-Send via createReplyAll

The system SHALL use `createReplyAll` for replies. `createReplyAll` preserves embedded images, CID references, and thread metadata. The system merges Graph's auto-quoted body with caller content rather than overwriting it. When `createReplyAll`, the body merge PATCH, or the final `/send` POST fails, `replyToMessage` SHALL return a structured `{ success: false, error: { code: 'REPLY_FAILED', recoverable: false } }` rather than silently falling back to `sendMail` — a `sendMail`-based message would lack `In-Reply-To` / `References` headers and so would not thread on the recipient side.

Updating the body of an existing draft SHALL NOT be performed by locating a quoted-history boundary within the body HTML. That approach is retired: the boundary marker is rewritten by intermediate systems — Gmail prefixes the id as `m_<digits>divRplyFwdMsg` and nests it on each round trip, Exchange prefixes it as `x_`, and drafts composed in Outlook mobile use a different container element entirely — so no marker match reliably identifies the authored region.

The system SHALL instead determine whether a draft is a reply from Graph metadata describing how the draft was created. This determination SHALL fail closed: when reply status cannot be established, the draft SHALL be treated as a reply and a body edit refused, so an indeterminate case cannot destroy quoted history.

#### Scenario: Reply preserves Graph auto-quoted thread (plain text)
- **WHEN** the original email has prior thread history
- **AND** the system replies via `createReplyAll` with plain-text content
- **THEN** the resulting draft preserves Graph's auto-generated quoted thread divider and prior-message header block alongside the caller content

#### Scenario: cid: references survive the merge unchanged
- **WHEN** the original email contains embedded images referenced via `cid:` URLs in Graph's quoted body
- **AND** the system replies via `createReplyAll`
- **THEN** the merged draft body retains every `cid:` reference intact

#### Scenario: createReplyAll failure returns structured REPLY_FAILED
- **WHEN** `createReplyAll`, the body-merge PATCH, or the final `/send` POST throws
- **THEN** `replyToMessage` returns `{ success: false, error: { code: 'REPLY_FAILED', recoverable: false } }`
- **AND** does not call `sendMail`

#### Scenario: Reply status is determined from provider metadata
- **WHEN** the system needs to know whether a draft is a reply in order to service `update_draft`
- **THEN** the determination is made from Graph metadata about the draft's origin
- **AND** the body HTML is not searched for a divider or boundary id

#### Scenario: An authored horizontal rule does not corrupt a draft
- **WHEN** `update_draft` is called on a draft whose authored body contains a horizontal rule (for example a markdown `---`)
- **THEN** no part of the authored body is mistaken for a quoted-history boundary
- **AND** the draft does not accumulate a second copy of previously authored content

#### Scenario: A prefixed or absent boundary marker does not destroy quoted history
- **WHEN** `update_draft` is called on a reply draft whose boundary id is prefixed by an intermediate system, or which uses a different container element entirely
- **THEN** the quoted history is preserved
- **AND** the body edit is refused rather than performed against an unrecognised structure

#### Scenario: Indeterminate reply status fails closed
- **WHEN** the system cannot establish from Graph metadata whether a draft is a reply
- **THEN** the draft is treated as a reply
- **AND** a body edit is refused
