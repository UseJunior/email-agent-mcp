## ADDED Requirements

### Requirement: Provider-Isolated Token Files

Saving one provider's mailbox metadata SHALL NOT overwrite or delete another
provider's metadata for the same email address. When the email-keyed filename
`<safe-key>.json` holds a record from another provider, a Gmail record SHALL be
stored as `<safe-key>.gmail.json`. Because safe keys are lossy, a new record
SHALL never be written to a file that holds another account's record. Mailbox
lookups SHALL resolve stored email addresses and names before filename stems.

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

#### Scenario: Gmail save never overwrites another account that shares a lossy safe key
- **WHEN** Gmail mailboxes are saved for `jane.doe@example.com` and `jane-doe@example.com` (same safe key)
- **THEN** each is stored in its own file and both remain loadable by address

#### Scenario: Microsoft lookup resolves stored names and addresses before filename stems
- **WHEN** a mailbox is looked up by an identifier that one record stores as its name and another file uses as its filename stem
- **THEN** the record that stores the identifier is returned
- **AND** filename stems are used only when no record claims the identifier

#### Scenario: A Gmail save that loses the filename race picks another name
- **WHEN** another save claims the filename a Gmail save chose, before the first save publishes
- **THEN** the first save chooses another free filename and both records survive
