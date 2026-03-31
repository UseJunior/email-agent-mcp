# email-agent-mcp — Next Steps

## Current State (2026-03-31)

| Metric | Value |
|--------|-------|
| npm | `email-agent-mcp@0.1.0` published |
| GitHub | `UseJunior/email-agent-mcp` — public, CI green |
| Build | 0 TypeScript errors |
| Tests | 64 passing across 4 packages |
| Spec coverage | 161/161 scenarios (100%) |
| MCP tools | 15 tools exposed via stdio |
| CI jobs | 10/10 passing (lint, test Node 20+22, codeql, semgrep, coverage, spec coverage, server.json, gemini manifest, actionlint) |
| Packages | 5 (email-core, provider-microsoft, provider-gmail, email-mcp, email-agent-mcp) |
| Specs | 15 OpenSpec specs |
| Adoption artifacts | server.json, gemini-extension.json, README in 5 languages |

## What's Built and Working

- **Action-centric architecture**: all 14 actions in email-core, MCP server is a thin adapter
- **Microsoft Graph provider**: MSAL device code OAuth with OS keychain persistence, delegated + client credentials auth, createReplyAll draft-then-send, Delta Query polling
- **Gmail provider**: OAuth2, message mapping, label mapping, Pub/Sub watch + history.list polling
- **Content engine**: HTML → markdown via node-html-markdown, tracking pixel stripping, signature stripping, CID image preservation, thread dedup stub
- **Security**: send allowlist (domain + email, gates all outbound including replies), receive allowlist, anti-spoofing (SPF/DKIM/DMARC), delete policy (disabled by default, soft delete), error sanitization, body_file path traversal protection
- **Multi-mailbox**: named mailboxes with default, write actions require explicit mailbox when >1 configured, canonical identity by email address, filesystem-safe storage keys
- **CLI**: TTY-aware defaults, interactive wizard with @clack/prompts, serve/watch/configure/status subcommands, config persistence at `~/.email-agent-mcp/`
- **Watcher**: timestamp-based polling, per-mailbox checkpoint persistence, lock files, receive allowlist gating, authenticated wake POST, text-only payloads for OpenClaw compatibility
- **Observability**: stderr-only logging, structured JSON format, error sanitization, MCP sendLoggingMessage

---

## Priority 1: End-to-End Validation

These are the most important next steps — proving the system works with real email.

### 1.1 Manual E2E Test with Real Microsoft 365 Account
- [ ] Run `npx email-agent-mcp` and complete the interactive setup wizard with a real O365 account
- [ ] Verify `list_emails`, `read_email`, `search_emails` return real data
- [ ] Verify `reply_to_email` sends a real reply (add yourself to send allowlist first)
- [ ] Verify `get_thread` returns a real conversation
- [ ] Verify `label_email`, `flag_email`, `mark_read`, `move_to_folder` work
- [ ] Verify `get_mailbox_status` shows correct unread count and warnings
- [ ] Test watcher: `npx email-agent-mcp watch` — send yourself an email and verify wake POST fires

### 1.2 Manual E2E Test with OpenClaw
- [ ] Add email-agent-mcp to `openclaw.json` as an MCP server
- [ ] Verify tools appear in OpenClaw's tool list
- [ ] Send an email to the configured mailbox, verify the watcher wakes OpenClaw
- [ ] Have OpenClaw read and reply to the email

### 1.3 Manual E2E Test with Claude Code
- [ ] Add to Claude Code `settings.json` as an MCP server
- [ ] Verify tools appear and work within a Claude Code session

---

## Priority 2: Hardening

### 2.1 Integration Tests with Real (or Recorded) API Responses
- [ ] Record real Graph API responses (list, read, search, thread, send) using a test harness
- [ ] Create integration test fixtures from the recordings
- [ ] Test the full action → provider → API flow with recorded data
- [ ] This catches issues that unit tests with mock providers miss (field mapping, pagination, error shapes)

### 2.2 Token Refresh Under Load
- [ ] Test that MSAL token refresh works correctly when access token expires mid-session
- [ ] Test that the watcher handles token refresh during long-running polling
- [ ] Test the 90-day refresh token expiry scenario (warn user before it expires)

### 2.3 Large Email Handling
- [ ] Test with emails >1MB (complex HTML, many inline images)
- [ ] Test with emails that have 10+ attachments
- [ ] Test the graceful truncation at 3.5MB
- [ ] Test with threads of 50+ messages

### 2.4 Error Recovery
- [ ] Test watcher behavior when Graph API is temporarily down (retry + checkpoint preservation)
- [ ] Test behavior when OAuth token is revoked mid-session
- [ ] Test behavior when send allowlist file is deleted while running

---

## Priority 3: Feature Completion

### 3.1 Gmail Provider E2E
- [ ] The Gmail provider has basic implementation but hasn't been E2E tested with real Gmail
- [ ] Complete the OAuth flow for Gmail (interactive setup wizard currently only supports Outlook)
- [ ] Add Gmail to the interactive wizard provider picker (currently shows "Gmail (coming soon)")
- [ ] Test Pub/Sub watch registration and 7-day auto-renewal

### 3.2 body_file Composition
- [ ] The `body_file` parameter is spec'd and tested but may need refinement
- [ ] Test with real .md files: write a draft, iterate, send
- [ ] Test markdown → HTML conversion quality (tables, links, formatting)

### 3.3 Draft Lifecycle
- [ ] `create_draft`, `update_draft`, `send_draft` are exposed as tools but may need polish
- [ ] Test the full draft iteration flow: create → read back → update → send

### 3.4 Attachment Operations
- [ ] Test downloading large attachments from real emails
- [ ] Test attaching files to outbound emails
- [ ] Test binary file detection with real-world file types
- [ ] Test filename sanitization with international characters

---

## Priority 4: Adoption & Distribution

### 4.1 Registry Submissions
- [ ] Submit to MCP Registry (registry.modelcontextprotocol.io)
- [ ] Submit to Smithery (smithery.ai)
- [ ] Package as MCPB bundle for Anthropic's extension directory
- [ ] Submit PR to modelcontextprotocol/servers GitHub repo

### 4.2 OpenClaw Skill
- [ ] Write a SKILL.md for the OpenClaw Skills Registry
- [ ] Include openclaw.json MCP config snippet in the skill
- [ ] Submit to the OpenClaw Skills Registry

### 4.3 Documentation
- [ ] Add a "Getting Started" guide with screenshots of the setup wizard
- [ ] Add a "Security Model" page explaining allowlists, anti-spoofing, delete policy
- [ ] Add architecture diagram (the mermaid diagrams from planning exist but aren't in the repo)
- [ ] Add API reference for all 15 tools with example inputs/outputs

### 4.4 npm 0.2.0 Release
- [ ] After E2E validation, bump to 0.2.0 with the fixes discovered
- [ ] Set up tag-driven release workflow (like safe-docx)
- [ ] Publish all 5 workspace packages to npm

---

## Priority 5: Future Enhancements

### 5.1 One-Click OpenClaw + Email Setup
- Railway template that deploys OpenClaw + email-agent-mcp + watcher in one click
- User connects email via OAuth during deploy
- Lowest barrier to entry for non-technical users

### 5.2 Graph Webhook Mode (Production)
- For deployments with a public HTTPS endpoint
- Use Graph change notifications instead of Delta Query polling
- Lower latency, less API usage
- Requires validation token handler, zombie detection, subscription renewal (all spec'd)

### 5.3 Multi-Language Server Generation
- Generate MCP server stubs in Python, Go, etc. from the Zod schemas
- Novel tooling — no "Fern for MCP" exists yet
- Would significantly broaden adoption

### 5.4 Thread Dedup (v2)
- Currently stubbed (no-op) because signature patterns vary too much
- Revisit as compute costs drop and the value of token savings decreases
- Could use LLM-based dedup (ask the model to identify quoted text) rather than heuristics

---

## Reference Files

| File | Purpose |
|------|---------|
| `openspec/specs/*/spec.md` | 15 spec files — source of truth for all requirements |
| `openspec/project.md` | Tech stack, architecture, code style, security defaults |
| `AGENTS.md` | AI agent instructions |
| `TEST_PLAN.md` | Test suite structure and traceability pattern |
| `OVERNIGHT_BUILD.md` | Ralph loop instructions for automated implementation |
| `GEMINI.md` | Full tool inventory and trust boundary docs |
| `~/.claude/plans/abstract-humming-flute.md` | Original approved architecture plan (in junior-AI-email-bot repo) |
