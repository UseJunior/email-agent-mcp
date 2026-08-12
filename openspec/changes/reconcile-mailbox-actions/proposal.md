# Reconcile Mailbox Actions

## Why

`email-core` contains an in-memory mailbox store that production never populates. Its configuration, list, and status actions are unreachable, while the CLI persists configuration and the MCP server correctly exposes state-backed diagnostic tools.

## What Changes

- Remove the unreachable `configure_mailbox`, `remove_mailbox`, `list_mailboxes`, and `get_mailbox_status` core actions and their in-memory store.
- Keep mailbox configuration as a CLI-only credential flow and retain state-backed MCP `list_mailboxes` and `get_mailbox_status` tools.
- Move reusable action metrics out of the removed status action module.
- Update the mailbox specification to describe the shipped CLI and MCP surfaces.

## Impact

- Affected specs: `mailbox-config`
- Affected code: `email-core` action registry and metrics; `email-mcp` tool documentation/tests
