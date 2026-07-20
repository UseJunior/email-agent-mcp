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

### Requirement: Bounded Folder Traversal

Recursive folder traversal MUST be bounded by a request budget shared across the entire traversal, not per collection. Exceeding the budget SHALL truncate the listing rather than fail it, and a truncated snapshot MUST NOT be cached.

#### Scenario: Truncate rather than fail on a very large mailbox
- **WHEN** enumerating folders would exceed the traversal request budget
- **THEN** `list_folders` returns the folders discovered so far instead of erroring

#### Scenario: Never cache a partial tree
- **WHEN** a traversal was truncated
- **THEN** the result is not written to the folder cache, so the next call retries from scratch

#### Scenario: Refuse to infer absence from a truncated tree
- **WHEN** a folder name cannot be found in a truncated snapshot
- **THEN** the system returns `FOLDER_TRAVERSAL_LIMIT`, not `FOLDER_NOT_FOUND`

### Requirement: Fresh Resolution For Write Operations

Folder name/path resolution for mutating operations (message moves, folder create/delete, rule destinations) MUST NOT be answered from the cached folder snapshot. A cached path-to-id mapping can point at a folder that was renamed or relocated out from under it, silently writing to the wrong destination.

#### Scenario: Re-resolve before a move
- **WHEN** `move_to_folder` resolves a custom folder name
- **THEN** the provider refreshes the folder tree before selecting the destination id

#### Scenario: Reads still use the cache
- **WHEN** `list_folders` is called twice within the cache TTL
- **THEN** the second call is served from the cached snapshot

### Requirement: Gated Folder Deletion

`delete_folder` MUST be disabled by default and gated behind the same operator deletion policy as `delete_email`, because deleting a folder discards every message it contains. It MUST require an explicit `user_explicitly_requested_deletion` affirmation and MUST return a typed `DELETE_DISABLED` error when the policy is off or the affirmation is absent.

#### Scenario: Folder deletion is disabled by default
- **WHEN** `delete_folder` is called and the operator has not enabled deletion
- **THEN** it returns `{success: false, error: {code: "DELETE_DISABLED", ...}}` without calling the provider

#### Scenario: Folder deletion requires explicit affirmation
- **WHEN** `delete_folder` is called with `user_explicitly_requested_deletion: false`
- **THEN** it returns `DELETE_DISABLED` without calling the provider
