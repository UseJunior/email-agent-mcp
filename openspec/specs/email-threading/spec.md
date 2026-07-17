---
epic: Email Operations
feature: Conversation Threading
---

## Purpose

Defines conversation thread retrieval and assembly. Uses provider-native thread IDs (Graph `conversationId`, Gmail `threadId`) with RFC header fallback (`Message-ID`, `In-Reply-To`, `References`) when provider IDs fail. Flattens multi-message threads into agent-friendly format.

### Requirement: Get Thread

The system SHALL provide a `get_thread` action that returns all messages in a conversation, ordered chronologically, with content engine transformations applied per message. The action SHALL retrieve the complete conversation from the provider (paging through provider continuation tokens rather than returning only the provider's first page), so the newest messages are never silently omitted. When the result is capped below the true conversation size, the action SHALL set `isTruncated: true` and report the true `messageCount`; when the whole conversation is returned it SHALL set `isTruncated: false`. The message identified by the passed `message_id` SHALL always be present in the result, even when it falls outside the newest window of a very long thread. Each returned message SHALL surface recipient topology — `to`, `cc`, and `bcc` — as explicit arrays of `Name <email>` strings, returning an empty array `[]` (never a missing key) when a field has no recipients, so a caller reasoning about reply-all scope can see who was on each message.

#### Scenario: Retrieve thread by message ID
- **WHEN** `get_thread` is called with `{message_id: "msg123"}`
- **THEN** the system identifies the conversation and returns all messages in chronological order
- **AND** each message reports `to`, `cc`, and `bcc` as arrays of `Name <email>` entries, using `[]` when a field has no recipients

#### Scenario: Graph subject-change breakage
- **WHEN** the conversation subject was changed mid-thread (Graph breaks `conversationId`)
- **THEN** the system falls back to RFC headers (`In-Reply-To`, `References`) to reconstruct the chain

#### Scenario: Gmail 100-message cap
- **WHEN** a thread exceeds 100 messages
- **THEN** the system returns the most recent 100 messages and sets `isTruncated: true` with the true `messageCount`
- **AND** when the queried `message_id` is older than that newest window, it is kept as the anchor (the queried message plus the most recent 99) so the queried message is always included

### Requirement: RFC Header Fallback

The system SHALL store `Message-ID`, `In-Reply-To`, and `References` headers from each email and use them as a fallback threading mechanism when provider-native thread IDs fail or are incomplete.

#### Scenario: Reconstruct broken thread
- **WHEN** `conversationId` returns an incomplete thread
- **THEN** the system uses `In-Reply-To` and `References` headers to find additional messages in the chain
