## ADDED Requirements

### Requirement: Recursive Folder Listing

The system SHALL provide a `list_folders` action that recursively lists every provider mail folder across all pages and includes a computed slash-delimited path for each folder.

#### Scenario: Nested paginated folders
- **WHEN** a Microsoft mailbox has paginated root folders and nested child folders
- **THEN** `list_folders` returns folders from every page and hierarchy level
- **AND** a child named `Newsletters` under `Inbox` has path `Inbox/Newsletters`

### Requirement: Folder Creation

The system SHALL provide a `create_folder` action that creates a custom child folder beneath a caller-selected parent folder and invalidates cached folder resolution data.

#### Scenario: Create an inbox child folder
- **WHEN** `create_folder` is called with `{display_name: "Newsletters", parent_folder: "inbox"}`
- **THEN** the provider creates `Newsletters` beneath Inbox
- **AND** a subsequent folder lookup observes the new folder without waiting for cache expiry

### Requirement: Protected Folder Deletion

The system SHALL provide a destructive `delete_folder` action for custom folders and SHALL refuse to delete well-known/system folders by alias, path, or resolved id.

#### Scenario: Refuse system folder id
- **WHEN** `delete_folder` resolves its input to the Graph id of Inbox
- **THEN** it returns a typed `SYSTEM_FOLDER_PROTECTED` error
- **AND** it does not call the Graph delete endpoint

### Requirement: Custom Folder Moves

The system SHALL resolve `move_to_folder` destinations by well-known alias, custom folder id, case-insensitive path, or unambiguous case-insensitive display name, with a 60-second cache for recursive folder data.

#### Scenario: Move to custom folder path
- **WHEN** `move_to_folder` is called with `{id: "msg123", folder: "Inbox/Newsletters"}`
- **THEN** the Microsoft provider posts the move using the resolved Graph folder id

#### Scenario: Preserve well-known move behavior
- **WHEN** `move_to_folder` is called with `inbox`, `archive`, or `trash`
- **THEN** the provider uses the corresponding well-known Graph destination without requiring folder traversal

### Requirement: Unsupported Folder Provider

Folder actions SHALL return a typed `NOT_SUPPORTED` result when the selected provider does not implement `EmailFolderManager`.

#### Scenario: Gmail folder request
- **WHEN** `list_folders` is called for a Gmail provider
- **THEN** the action returns `{success: false, error: {code: "NOT_SUPPORTED", ...}}`
