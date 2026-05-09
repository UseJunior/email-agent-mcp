## ADDED Requirements

### Requirement: Optional Quoted-History Stripping

The `read_email` action SHALL accept an optional `strip_quoted_history` boolean parameter. When `true`, the system SHALL detect a terminal quoted-history block — Gmail/Apple "On … wrote:" preambles, Outlook `From:/Sent:/Date:/To:/Subject:` header clusters, an Outlook-2003 `-----Original Message-----` separator followed by an Outlook header cluster, or a terminal run of `>`-prefix lines — and replace it with a single short marker (e.g. `[...prior thread truncated]`). The candidate block SHALL only be stripped when it is genuinely terminal: an inline `On … wrote:` quote followed by user-authored prose SHALL NOT be stripped. When omitted or `false`, the body SHALL be returned unchanged from current behavior. Inline blockquotes appearing within the latest reply SHALL be preserved; only a terminal quoted-history block SHALL be stripped.

The detector is English-only: localized "On … wrote:" preambles (German "Am … schrieb …", French "Le … a écrit", Japanese "送信者:" headers, etc.) are NOT matched. Threads from non-English clients SHALL be returned with full quoted history.

#### Scenario: Strip quoted history when flag is true
- **WHEN** `read_email` is called with `{id: "msg123", strip_quoted_history: true}` and the email body contains a Gmail "On … wrote:" preamble followed by a multi-line `>`-prefix quoted reply
- **THEN** the returned body has the preamble and quoted reply replaced with the marker `[...prior thread truncated]`
- **AND** the latest reply text and any non-quoted user content above the preamble are preserved

#### Scenario: Default behavior is unchanged
- **WHEN** `read_email` is called with `{id: "msg123"}` (flag omitted) on the same email
- **THEN** the returned body is identical to current behavior — full quoted history is included

#### Scenario: Inline blockquote in latest reply is preserved
- **WHEN** `read_email` is called with `{id: "msg123", strip_quoted_history: true}` on an email whose latest reply contains a markdown blockquote (`> note:` line) followed by more user-authored text and no terminal quoted-history block
- **THEN** the returned body is unchanged and no marker is inserted

#### Scenario: Inline "On … wrote:" with user prose after is preserved
- **WHEN** `read_email` is called with `{id: "msg123", strip_quoted_history: true}` on a body that contains an `On … wrote:` preamble and `>`-quoted block in the middle, followed by additional user-authored prose
- **THEN** the returned body is unchanged and no marker is inserted
