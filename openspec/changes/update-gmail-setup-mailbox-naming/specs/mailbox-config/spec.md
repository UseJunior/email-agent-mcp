## ADDED Requirements

### Requirement: Provider-Isolated Token Files

Saving one provider's mailbox metadata SHALL NOT overwrite or delete another
provider's metadata for the same email address. When the email-keyed filename
`<safe-key>.json` holds a record from another provider, a Gmail record SHALL be
stored as `<safe-key>.gmail.json`.

#### Scenario: Gmail save never overwrites a Microsoft record for the same address
- **WHEN** a Gmail mailbox is saved for an address whose `<safe-key>.json` holds a Microsoft record
- **THEN** the Gmail record is written to `<safe-key>.gmail.json` and the Microsoft record is unchanged

#### Scenario: Microsoft save moves a Gmail record aside instead of overwriting it
- **WHEN** a Microsoft mailbox is saved to a `<safe-key>.json` that holds a Gmail record
- **THEN** the Gmail record is moved to `<safe-key>.gmail.json` first
- **AND** if that name is already taken, the Microsoft save fails and the Gmail record is unchanged

#### Scenario: Microsoft configure keeps a Gmail mailbox for the same address
- **WHEN** Microsoft configure removes superseded token files for the authenticated address
- **THEN** Gmail records for that address are kept
