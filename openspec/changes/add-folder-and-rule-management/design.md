## Context

Folder and rule behavior differs sharply between Microsoft Graph and Gmail. Graph exposes hierarchical mail folders and Exchange inbox rules, while Gmail's closest primitives are labels and filters. The action registry must remain the single source of truth and transport adapters must remain generic.

## Goals / Non-Goals

- Goals: hierarchical folder CRUD, faithful rule listing, safe minimal rule creation, server-side rule deletion, and custom-folder moves for Microsoft Graph.
- Goals: typed graceful degradation for providers that omit either capability.
- Non-goals: Gmail label/filter emulation, client-side rule execution, unsafe forwarding/redirection/deletion actions, and transport-specific business logic.

## Decisions

### Optional provider capabilities

`EmailFolderManager` and `EmailRuleManager` are composed into `EmailProvider` with `Partial<...>`, matching existing optional categorization and attachment capabilities. Core actions test for method presence and return `NOT_SUPPORTED` when absent.

### Folder shape and traversal

`listFolders` returns a flat recursive list. Each folder retains Graph folder fields used by callers and gains a computed slash-delimited `path`. Traversal follows `@odata.nextLink` for roots and every `childFolders` collection. A visited-id guard prevents pathological cycles.

### Folder resolution and caching

Resolution checks well-known aliases first to preserve existing behavior and avoid unnecessary calls. Custom input then matches ids, case-insensitive paths, or a unique case-insensitive display name. Ambiguous display names return a typed provider error asking for a path. The recursive folder list is cached for 60 seconds per provider instance and invalidated after successful create/delete.

### System-folder deletion protection

Deletion rejects known system aliases before resolution. It also loads the well-known folders and rejects a custom request if its resolved id equals a system-folder id. This closes the alias/id bypass while still permitting custom descendants.

### Faithful list, minimal create

`listInboxRules` returns Graph rule objects without discarding fields, including externally created rules containing unsafe actions. `createInboxRule` accepts Graph conditions/exceptions plus a deliberately small set of safe actions. Blocked action keys (`forwardTo`, `forwardAsAttachmentTo`, `redirectTo`, and `delete`) remain representable at the action boundary so the core action can return a typed `UNSAFE_RULE_ACTION` response instead of throwing a schema-validation exception. A `user_explicitly_approved` flag is required and must be true.

### Gmail behavior

The Gmail provider does not implement either optional capability. Gmail has labels rather than hierarchical folders and its filter model is not treated as equivalent to Exchange inbox rules. Core actions therefore return `NOT_SUPPORTED` consistently.

### Authentication

Both short and full-URL delegated scope lists add `MailboxSettings.ReadWrite`. Existing cached consent may not include the new permission, so users must re-consent.

## Risks / Trade-offs

- Recursive traversal can make several Graph calls; pagination guards and the 60-second cache bound repeated resolver cost.
- Display names need not be unique; ambiguous names are rejected in favor of explicit paths.
- Faithful rule output is intentionally looser than create input so future Graph fields are not silently lost.
