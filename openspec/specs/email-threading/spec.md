---
epic: Email Operations
feature: Conversation Threading
---

## Purpose

Defines conversation thread retrieval and assembly. Uses provider-native thread IDs (Graph `conversationId`, Gmail `threadId`) with RFC header fallback (`Message-ID`, `In-Reply-To`, `References`) when provider IDs fail. Flattens multi-message threads into agent-friendly format.

### Requirement: Get Thread

The system SHALL provide a `get_thread` action that returns all messages in a conversation, ordered chronologically, with content engine transformations applied per message.

#### Scenario: Retrieve thread by message ID
- **WHEN** `get_thread` is called with `{message_id: "msg123"}`
- **THEN** the system identifies the conversation and returns all messages in chronological order

#### Scenario: Graph subject-change breakage
- **WHEN** the conversation subject was changed mid-thread (Graph breaks `conversationId`)
- **THEN** the system falls back to RFC headers (`In-Reply-To`, `References`) to reconstruct the chain

#### Scenario: Gmail 100-message cap
- **WHEN** a Gmail thread exceeds 100 messages
- **THEN** the system returns the most recent 100 and indicates truncation

### Requirement: RFC Header Fallback

The system SHALL store `Message-ID`, `In-Reply-To`, and `References` headers from each email and use them as a fallback threading mechanism when provider-native thread IDs fail or are incomplete.

#### Scenario: Reconstruct broken thread
- **WHEN** `conversationId` returns an incomplete thread
- **THEN** the system uses `In-Reply-To` and `References` headers to find additional messages in the chain
