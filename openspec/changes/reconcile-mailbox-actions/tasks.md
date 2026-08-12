# Tasks

## 1. Remove unreachable actions
- [x] 1.1 Delete the in-memory mailbox store and its configuration/list actions.
- [x] 1.2 Delete the unreachable mailbox-status action and move metrics helpers to a dedicated module.
- [x] 1.3 Remove the obsolete actions from `EMAIL_ACTIONS` and their tests.

## 2. Preserve shipped mailbox tools
- [x] 2.1 Retain state-backed MCP `list_mailboxes` and `get_mailbox_status` wire shapes.
- [x] 2.2 Replace stale dead-code comments with the positive state-as-source-of-truth design.

## 3. Specification and verification
- [x] 3.1 Update the mailbox configuration requirements for CLI configuration and MCP diagnostics.
- [x] 3.2 Run tests, lint, build, strict OpenSpec validation, and spec coverage.
