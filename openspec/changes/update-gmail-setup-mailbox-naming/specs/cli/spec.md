## ADDED Requirements

### Requirement: Gmail Setup Mailbox Naming

Gmail `configure` / `setup` SHALL choose or confirm the mailbox name after
OAuth, once the authenticated Google account is known. A name clash SHALL NOT
discard a successful authorization, and the system SHALL NOT overwrite a
mailbox that is linked to a different account. Setup SHALL NOT require a TTY.

#### Scenario: Default alias taken by another account falls back to a derived name after OAuth
- **WHEN** `setup --provider gmail` runs without `--mailbox`
- **AND** the authenticated account is not configured yet
- **THEN** the mailbox is named after the account's address (for example `jane@example.com` → `jane-example`), not `default`
- **AND** the setup output names the linked account and mailbox

#### Scenario: Derived default name avoids every provider's mailbox names
- **WHEN** the derived name is already used as a name or email address by any configured mailbox on any provider
- **THEN** the system appends `-2`, `-3`, ... until the name is unique

#### Scenario: Setup without --mailbox prompts with the derived name in a TTY
- **WHEN** setup runs without `--mailbox` and without `--yes` with stdin and stdout attached to a TTY
- **THEN** the system asks for the mailbox name, offering the derived name as the default

#### Scenario: Reconnecting an already-configured account keeps its mailbox name
- **WHEN** the authenticated account already has a Gmail mailbox
- **AND** `--mailbox` is omitted or is that account's email address
- **THEN** the existing mailbox name is kept

#### Scenario: Explicit --mailbox alias completes without a TTY and reports the linked account
- **WHEN** `setup --provider gmail --mailbox <alias>` runs without a TTY and the alias is free
- **THEN** the account is saved as `<alias>`
- **AND** the output states which Google account was linked

#### Scenario: Explicit alias in a TTY asks for confirmation unless --yes or --confirm-account is given
- **WHEN** an explicit, free alias is requested from a TTY
- **THEN** the system asks the user to confirm the authenticated account, unless `--yes` or a matching `--confirm-account` was passed

#### Scenario: --confirm-account is the login hint and a mismatch saves nothing
- **WHEN** `--confirm-account <email>` is passed
- **THEN** it is sent to Google as the login hint
- **AND** if a different account signs in, setup exits non-zero and saves nothing

#### Scenario: Requested alias owned by another account keeps the authorization under a safe name
- **WHEN** `--mailbox <alias>` names a mailbox linked to a different account and no TTY is available (or `--yes` is passed)
- **THEN** the existing mailbox is not modified
- **AND** the authenticated account is saved under its existing name or the derived name
- **AND** setup exits 1 and explains how to rename the new mailbox

#### Scenario: Alias clash in a TTY prompts for another name instead of failing
- **WHEN** `--mailbox <alias>` names a mailbox linked to a different account and a TTY is available
- **THEN** the system explains the clash and asks for another name without a new sign-in

#### Scenario: A --mailbox name held by a Microsoft mailbox fails before OAuth starts
- **WHEN** `--mailbox` equals the name or email address of a non-Gmail mailbox
- **THEN** setup exits non-zero before starting OAuth

### Requirement: Mailbox Rename Subcommand

The system SHALL provide `email-agent-mcp mailbox rename <old> <new>
[--provider gmail|microsoft]`, which renames a configured mailbox without a new
sign-in. It SHALL refuse a new name that is used as a name or email address by
any other mailbox on any provider.

#### Scenario: Rename a Gmail mailbox without signing in again
- **WHEN** `mailbox rename default personal` is run for a Gmail mailbox
- **THEN** the mailbox's token record carries the name `personal` and keeps its tokens
- **AND** the token file stays at its email-keyed path

#### Scenario: Rename a Microsoft mailbox pins its token cache name
- **WHEN** a Microsoft mailbox whose record has no stored `cacheName` is renamed
- **THEN** the record stores the cache name derived from the old name, so the cached tokens are still found

#### Scenario: Rename refuses a name used by any mailbox on any provider
- **WHEN** the new name equals another mailbox's name or email address, on any provider and in any letter case
- **THEN** the command exits 1 and changes nothing

#### Scenario: Rename reports a missing source mailbox
- **WHEN** no mailbox has the old name
- **THEN** the command exits 1 and lists the configured mailboxes

#### Scenario: Rename requires --provider when two providers share a name
- **WHEN** the old name matches mailboxes on more than one provider
- **THEN** the command exits 1 and asks for `--provider`
