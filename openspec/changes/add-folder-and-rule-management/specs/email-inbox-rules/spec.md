## ADDED Requirements

### Requirement: Faithful Inbox Rule Listing

The system SHALL provide a read-only `list_inbox_rules` action that returns all fields supplied by the provider, including unsafe actions on rules created outside this system.

#### Scenario: List externally created forwarding rule
- **WHEN** Graph returns a rule containing `forwardTo`
- **THEN** `list_inbox_rules` returns the rule and its `forwardTo` action unchanged

### Requirement: Safe Approved Inbox Rule Creation

The system SHALL provide `create_inbox_rule` with minimal safe actions and SHALL require the caller to affirm that a human explicitly approved the proposed rule before it is created.

#### Scenario: Create approved move rule
- **WHEN** `create_inbox_rule` receives an approved rule that moves matching mail to a custom folder
- **THEN** the system resolves the folder and creates the rule through the provider

#### Scenario: Missing human approval
- **WHEN** `create_inbox_rule` is called without `user_explicitly_approved: true`
- **THEN** it returns a typed `APPROVAL_REQUIRED` error without calling the provider

### Requirement: Unsafe Rule Action Rejection

The system MUST reject creation of any inbox rule whose actions contain `forwardTo`, `forwardAsAttachmentTo`, `redirectTo`, or `delete`, returning a typed error instead of throwing.

#### Scenario: Reject forwarding action
- **WHEN** `create_inbox_rule` receives an action containing `forwardTo`
- **THEN** it returns `{success: false, error: {code: "UNSAFE_RULE_ACTION", ...}}`
- **AND** it does not call the provider

### Requirement: Inbox Rule Deletion

The system SHALL provide a destructive `delete_inbox_rule` action that deletes a rule by id.

#### Scenario: Delete a rule
- **WHEN** `delete_inbox_rule` is called with `{id: "rule123"}`
- **THEN** the provider deletes `rule123` from the inbox rules collection

### Requirement: Unsupported Rule Provider

Inbox-rule actions SHALL return a typed `NOT_SUPPORTED` result when the selected provider does not implement `EmailRuleManager`.

#### Scenario: Gmail rule request
- **WHEN** `list_inbox_rules` is called for a Gmail provider
- **THEN** the action returns `{success: false, error: {code: "NOT_SUPPORTED", ...}}`
