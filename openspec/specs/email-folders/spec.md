# email-folders Specification

## Purpose

Defines mail-folder management: recursively listing every provider folder with a computed path, creating custom child folders, and deleting custom folders (gated, with well-known/system folders protected). Folder-path resolution for `move_to_folder` is served from a 60-second cache since moves don't alter the tree, while resolution for structural writes and rule destinations always forces a fresh traversal.

## Requirements
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
- **WHEN** a folder NAME or PATH match is the only candidate in a truncated snapshot
- **THEN** the system returns `FOLDER_TRAVERSAL_LIMIT` rather than assuming the visible match is unique
- **AND** an exact folder-id match still resolves, because ids are globally unique

### Requirement: Fresh Resolution For Structural And Rule Writes

Folder name/path resolution for operations that MUTATE the folder tree (`create_folder` parent, `delete_folder` target) and for inbox-rule destinations MUST NOT be answered from the cached folder snapshot. These are low-frequency and either unrecoverable (deleting the wrong folder) or persistent (a rule that acts 24/7), so a stale path-to-id mapping is worth one fresh traversal to avoid.

#### Scenario: Re-resolve before a structural mutation
- **WHEN** `create_folder` or `delete_folder` resolves its target folder
- **THEN** the provider refreshes the folder tree before selecting the id

#### Scenario: Re-resolve a rule destination
- **WHEN** `create_inbox_rule` resolves a custom folder destination
- **THEN** the provider refreshes the folder tree and resolves to an opaque folder id

### Requirement: Cached Resolution For Message Moves

`move_to_folder` name resolution SHALL be permitted to use the cached folder snapshot rather than forcing a fresh traversal. A move does not alter the folder tree, runs in high-volume triage loops, and its worst-case staleness (a message filed into a renamed-but-valid folder within the 60s TTL) is recoverable — so forcing a fresh traversal per move, which would trip Graph throttling on the exact workload this feature targets, is the wrong trade. An exact folder id MUST still resolve without depending on a fresh traversal.

#### Scenario: Repeated moves reuse the cache
- **WHEN** several `move_to_folder` calls target custom folders within the cache TTL
- **THEN** only the first performs a folder traversal; the rest are served from cache

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

