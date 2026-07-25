## ADDED Requirements

### Requirement: Draft Status Mapping

The system SHALL map Microsoft Graph's `message.isDraft` property onto `EmailMessage.isDraft`.

`isDraft` SHALL be included in `MESSAGE_SELECT`, the explicit message `$select` projection used by `getMessage` and by `getThread`'s anchor lookup. Without it Graph omits the property from those responses and an unsent draft becomes indistinguishable from delivered mail.

`listMessages`, `searchMessages`, and `getThread`'s paged conversation collection send no `$select` and therefore rely on Graph's default message projection, which carries `isDraft` (verified live: 25/25 drafts returned `isDraft: true` through both listing and search). Because the mapper coerces an absent property to `false`, a future narrowing of Graph's default projection would silently turn a real draft into an affirmative `isDraft: false`. Hardening those three paths with an explicit projection is tracked separately.

The delta query projection is deliberately excluded: delta results feed only the watcher wake payload for newly-delivered inbox mail, which does not report draft status.

#### Scenario: Graph draft status maps to isDraft
- **WHEN** `getMessage` fetches a message Graph reports with `isDraft: true`
- **THEN** the mapped `EmailMessage` has `isDraft: true`
- **AND** the request's `$select` includes `isDraft`

#### Scenario: a delivered Graph message maps to isDraft false
- **WHEN** `getMessage` fetches a message Graph reports with `isDraft: false`
- **THEN** the mapped `EmailMessage` has `isDraft: false`
