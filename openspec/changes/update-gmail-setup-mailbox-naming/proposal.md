## Why

Adding a second Gmail mailbox with `setup --provider gmail` failed after the
user had already signed in to Google, and the authorization was thrown away
(issue #289):

- Without `--mailbox`, setup used the alias `default`, which was already linked
  to another Google account.
- With `--mailbox <alias>` and no TTY (for example an agent host's shell),
  setup refused because "the alias does not prove which account you intended".
  Its suggested fallback, `--mailbox <email>`, could clash with an Outlook
  mailbox for the same address.

A related data-loss bug: Gmail and Microsoft token files for the same address
share the filename `tokens/<safe-key>.json`, so configuring one provider
overwrote the other's tokens, and Microsoft configure deleted Gmail records it
mistook for superseded aliases.

## What Changes

- Gmail setup chooses the mailbox name after OAuth, once the account is known.
  - Without `--mailbox`, an account that is already configured keeps its name;
    a new account gets a name derived from its address (`jane@example.com` →
    `jane-example`) that does not clash with any mailbox on any provider. In a
    TTY the user is asked to confirm or change it.
  - An explicit `--mailbox <alias>` is enough intent without a TTY. Setup
    prints which account was linked.
  - New `--confirm-account <email>` (hard-fails on mismatch, saves nothing) and
    `--yes` / `-y` (accept the suggestion, skip confirmation prompts).
  - When `--mailbox` names a mailbox linked to a different account, setup still
    refuses to overwrite it. In a TTY it asks for another name; without a TTY it
    saves the account under the derived name and exits 1, so the user does not
    have to sign in again.
  - A `--mailbox` name held by a non-Gmail mailbox is refused before OAuth.
- New `email-agent-mcp mailbox rename <old> <new> [--provider ...]` renames a
  mailbox without a new sign-in and refuses collisions on any provider.
- Token files of different providers never overwrite each other. A Gmail record
  whose email-keyed filename is taken by a Microsoft record is stored as
  `<safe-key>.gmail.json`; Microsoft saves move a Gmail record out of the way
  first; Microsoft configure's superseded-file cleanup skips Gmail records.

## Impact

- Affected specs: `cli`, `mailbox-config`
- Affected code: `packages/email-mcp/src/cli.ts`,
  `packages/email-mcp/src/mailbox-names.ts` (new),
  `packages/provider-gmail/src/config.ts`,
  `packages/provider-microsoft/src/auth.ts`, and their tests
- User-visible behavior: Gmail setup no longer needs a TTY and no longer
  discards a successful sign-in because of a name clash. Setup without
  `--mailbox` names new Gmail mailboxes after the account instead of `default`.
