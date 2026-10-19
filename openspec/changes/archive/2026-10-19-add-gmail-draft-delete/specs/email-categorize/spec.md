## ADDED Requirements

### Requirement: Delete Provider Errors

`delete_email` SHALL return provider failures as structured results rather than throwing: a `ProviderError` keeps its code, message, and recoverability; `MessageNotFoundError` becomes `MESSAGE_NOT_FOUND`; any other failure becomes `DELETE_FAILED`.

#### Scenario: Provider refusal is returned as a structured error
- **WHEN** the provider's `deleteMessage` raises `ProviderError('NOT_SUPPORTED', …)`
- **THEN** `delete_email` returns `{success: false, error: {code: "NOT_SUPPORTED", …}}`

#### Scenario: Unknown message id is returned as MESSAGE_NOT_FOUND
- **WHEN** the provider's `deleteMessage` raises `MessageNotFoundError`
- **THEN** `delete_email` returns `MESSAGE_NOT_FOUND`

#### Scenario: Unexpected delete failure falls back to DELETE_FAILED
- **WHEN** the provider's `deleteMessage` raises a plain error
- **THEN** `delete_email` returns `DELETE_FAILED` with the error message
