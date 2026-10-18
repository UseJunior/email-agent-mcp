## MODIFIED Requirements

### Requirement: Delete Policy

Delete SHALL be disabled by default. Two independent gates govern deletion: an operator-controlled env var (`AGENT_EMAIL_DELETE_ENABLED=true`) AND a per-call flag (`user_explicitly_requested_deletion: true`). Permanent deletion adds a third gate (`AGENT_EMAIL_HARD_DELETE_ENABLED=true`). All gates use strict-equality checks and accept only the literal string `'true'` to enable. Default to soft delete (move to Trash). Where a provider can only delete an item permanently and the item was never delivered — a Gmail draft, which Gmail cannot trash — the delete MAY proceed under the soft-delete gates alone; it SHALL still be refused when the caller passes `hard_delete: true` without `AGENT_EMAIL_HARD_DELETE_ENABLED=true`, and the provider SHALL document that the delete is permanent. Delivered mail on every provider keeps the soft-delete default. No bulk delete.

#### Scenario: Disabled by default
- **WHEN** `AGENT_EMAIL_DELETE_ENABLED` is unset or any value other than `'true'`
- **THEN** `delete_email` returns a `DELETE_DISABLED` error whose message names `AGENT_EMAIL_DELETE_ENABLED` so operators can self-remediate

#### Scenario: Soft delete
- **WHEN** `AGENT_EMAIL_DELETE_ENABLED=true` AND the caller passes `user_explicitly_requested_deletion: true`
- **THEN** the email is moved to Trash (soft delete)

#### Scenario: Hard delete requires both server gate and explicit flag
- **WHEN** `AGENT_EMAIL_HARD_DELETE_ENABLED=true` AND `hard_delete: true` is passed (with the soft-delete gates above also satisfied)
- **THEN** the email is permanently deleted

#### Scenario: Hard delete blocked when only soft is enabled
- **WHEN** `AGENT_EMAIL_DELETE_ENABLED=true` but `AGENT_EMAIL_HARD_DELETE_ENABLED` is not `'true'`
- **AND** the caller passes `hard_delete: true`
- **THEN** `delete_email` returns `DELETE_DISABLED` and the message names `AGENT_EMAIL_HARD_DELETE_ENABLED`

#### Scenario: Misconfigured env vars warn at startup
- **WHEN** an env var is set to a non-empty unsupported value (e.g. `'1'`, `'yes'`)
- **OR** `AGENT_EMAIL_HARD_DELETE_ENABLED=true` is set without `AGENT_EMAIL_DELETE_ENABLED=true`
- **THEN** the process logs a stderr warning at startup so operators can correct the config rather than silently fall back to disabled
