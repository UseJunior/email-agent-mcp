---
epic: Email Operations
feature: Email Classification & Labeling
---

## Purpose

Defines actions for classifying and organizing existing emails: labeling, flagging, marking read/unread, and moving to folders. The MCP applies labels as directed — the AI agent does the thinking. No delete in v1. Provider mapping: Graph categories/flags to Gmail labels/stars.

### Requirement: Label Email

The system SHALL provide a `label_email` action that applies a label or category to an email as directed by the agent.

#### Scenario: Apply label
- **WHEN** `label_email` is called with `{id: "msg123", labels: ["important", "client-correspondence"]}`
- **THEN** the system applies the labels via the provider (Graph categories or Gmail labels)

#### Scenario: Bulk labeling
- **WHEN** `label_email` is called with `{ids: ["msg1", "msg2", "msg3"], labels: ["receipts"]}`
- **THEN** the system applies the label to all specified messages

### Requirement: Flag Email

The system SHALL provide `flag_email` and `unflag_email` actions to mark emails as important/starred/flagged.

#### Scenario: Flag as important
- **WHEN** `flag_email` is called with `{id: "msg123"}`
- **THEN** the system sets the importance flag (Graph: flag, Gmail: star)

### Requirement: Mark Read State

The system SHALL provide `mark_read` and `mark_unread` actions to toggle email read state.

#### Scenario: Mark as read
- **WHEN** `mark_read` is called with `{id: "msg123"}`
- **THEN** the system marks the email as read

### Requirement: Move to Folder

The system SHALL provide a `move_to_folder` action to move emails between folders.

#### Scenario: Archive email
- **WHEN** `move_to_folder` is called with `{id: "msg123", folder: "archive"}`
- **THEN** the system moves the email to the archive folder

### Requirement: No Delete in v1

The system SHALL NOT provide a delete action by default. Delete is disabled in configuration and requires explicit enablement plus `user_explicitly_requested_deletion: true`.

#### Scenario: Delete attempt when disabled
- **WHEN** a delete action is attempted and delete is disabled in config
- **THEN** the system returns an error: "Email deletion is disabled. Enable in configuration if needed."
