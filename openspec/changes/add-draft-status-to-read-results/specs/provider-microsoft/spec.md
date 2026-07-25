## ADDED Requirements

### Requirement: Draft Status Mapping

The system SHALL map Microsoft Graph's `message.isDraft` property onto `EmailMessage.isDraft`.

`isDraft` SHALL be included in the explicit message `$select` projection used by `getMessage` and `getThread`. Without it Graph omits the property from the response and an unsent draft becomes indistinguishable from delivered mail. Listing and search send no `$select`, so Graph's default projection already carries the property there.

The delta query projection is deliberately excluded: delta results feed only the watcher wake payload for newly-delivered inbox mail, which does not report draft status.

#### Scenario: Graph draft status maps to isDraft
- **WHEN** `getMessage` fetches a message Graph reports with `isDraft: true`
- **THEN** the mapped `EmailMessage` has `isDraft: true`
- **AND** the request's `$select` includes `isDraft`

#### Scenario: a delivered Graph message maps to isDraft false
- **WHEN** `getMessage` fetches a message Graph reports with `isDraft: false`
- **THEN** the mapped `EmailMessage` has `isDraft: false`
