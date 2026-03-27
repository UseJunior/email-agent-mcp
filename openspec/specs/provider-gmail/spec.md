---
epic: Infrastructure
feature: Gmail Provider
---

## Purpose

Implements the provider interface for Gmail API email operations. Uses `@googleapis/gmail` (lightweight, ~1.1MB). Supports OAuth2 authentication, Gmail-specific label/star mapping, dual watch mode (Pub/Sub with 7-day auto-renewal + history.list polling fallback), and anti-spoofing via Authentication-Results headers.

### Requirement: OAuth2 Authentication

The system SHALL authenticate to Gmail via OAuth2 using `@googleapis/gmail` (NOT the full `googleapis` package at 200MB).

#### Scenario: Gmail OAuth
- **WHEN** `configure_mailbox` is called with `{provider: "gmail"}`
- **THEN** the system initiates OAuth2 flow and persists refresh tokens

### Requirement: Message Mapping

The system SHALL map Gmail message format to the common `EmailMessage` type, including labels, thread IDs, and attachment metadata.

#### Scenario: Gmail message to EmailMessage
- **WHEN** a Gmail message is fetched
- **THEN** it is mapped to `EmailMessage` with `threadId`, labels, and standard fields

### Requirement: Dual Watch Mode

The system SHALL support Pub/Sub push notifications (requires Google Cloud project, auto-renewal every 7 days) and `history.list` polling as a fallback for local/NAT environments.

#### Scenario: Pub/Sub auto-renewal
- **WHEN** the Pub/Sub watch registration approaches 7-day expiry
- **THEN** the system automatically re-registers via `users.watch()`

#### Scenario: history.list fallback
- **WHEN** Pub/Sub is not configured
- **THEN** the system polls `history.list` at a configurable interval (default 30s)

### Requirement: Label Mapping

The system SHALL map Gmail labels to folder/category concepts: `INBOX`, `SENT`, `TRASH`, `SPAM`, `STARRED`, `IMPORTANT`, and custom labels.

#### Scenario: Label as folder
- **WHEN** `list_emails` is called with `{folder: "junk"}`
- **THEN** the system queries messages with the `SPAM` label

### Requirement: NemoClaw Compatibility

The system SHALL document required egress domains: `gmail.googleapis.com`, `oauth2.googleapis.com`, `pubsub.googleapis.com`.

#### Scenario: NemoClaw egress
- **WHEN** running in NemoClaw
- **THEN** these domains are added to the egress policy
