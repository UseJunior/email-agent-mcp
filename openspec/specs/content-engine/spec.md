---
epic: Content Processing
feature: AI-Ready Email Transformation
---

## Purpose

Transforms raw email content (HTML or plaintext) into a token-efficient representation optimized for LLM consumption. Handles HTML sanitization, signature stripping, encoding normalization, and attachment summarization. Thread dedup is stubbed for v1 — rely on limit parameters instead.

### Requirement: HTML to Token-Efficient Markdown

The system SHALL convert HTML email bodies to token-efficient markdown, preserving tables, lists, and links while stripping tracking pixels, CSS, scripts, and hidden elements.

#### Scenario: HTML with tracking pixel
- **WHEN** an HTML email contains `<img src="https://tracker.example.com/pixel.gif" width="1" height="1">`
- **THEN** the system strips the tracking pixel from the output

#### Scenario: Table preservation
- **WHEN** an HTML email contains a data table
- **THEN** the system converts it to markdown table format

### Requirement: Signature Stripping

The system SHALL strip email signatures and legal disclaimers using heuristic-based detection. Configurable (can be disabled).

#### Scenario: Common signature pattern
- **WHEN** an email ends with "-- \nJohn Doe\nSenior Partner"
- **THEN** the system strips the signature from the body content

### Requirement: Thread Dedup (Stub for v1)

The system SHALL provide a no-op dedup implementation in v1. Quoted reply chains ("On [date], [user] wrote:") are preserved in full. Rely on `limit` parameters with sensible defaults so the agent reads incrementally and stops at repetitive content.

#### Scenario: Quoted text preserved
- **WHEN** an email contains "On March 1, Alice wrote:" followed by quoted text
- **THEN** the system preserves the full quoted content (no stripping in v1)

### Requirement: Encoding Handling

The system SHALL handle MIME type negotiation (prefer HTML, fall back to plaintext), normalize character encoding to UTF-8, and preserve emoji and non-Latin scripts.

#### Scenario: Non-UTF8 email
- **WHEN** an email is encoded in ISO-8859-1
- **THEN** the system normalizes to UTF-8 without data loss

### Requirement: Attachment Summary

The system SHALL generate inline descriptions of attachments without including full content, to help the agent understand what's attached.

#### Scenario: Attachment list in body
- **WHEN** an email has 3 attachments
- **THEN** the output includes: "Attachments: contract.docx (245KB), logo.png (inline), data.xlsx (1.2MB)"
