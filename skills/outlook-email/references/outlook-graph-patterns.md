# Outlook & Graph API Patterns for Email Agents

This reference covers practical patterns for agents working with Microsoft 365 email via the Graph API. These patterns work with any Graph API client; sections marked **(MCP)** show how `email-agent-mcp` (open source, Apache-2.0: https://github.com/UseJunior/email-agent-mcp) wraps them with smart defaults.

## 1. Listing vs Searching Email

| Approach | REST Endpoint | Best For |
|----------|--------------|----------|
| **List + filter** | `GET /me/messages?$filter=...&$orderby=receivedDateTime desc` | Quick inbox scan, filtering by sender, date range, unread status. Structured, predictable. |
| **Full-text search** | `GET /me/messages?$search="keyword"` | Finding emails by content. Uses KQL (Keyword Query Language). Powerful but has combination gotchas. |

**Rule of thumb**: Start with list + filter for "show me recent mail" tasks. Escalate to search when you need keyword matching across email bodies.

**(MCP)**: `list_emails` wraps list+filter; `search_emails` wraps full-text search. Both handle pagination and token-efficient body formatting automatically.

## 2. Known Graph API Search Gotcha

The Graph API's `$search` endpoint cannot combine `from:` + `to:` KQL prefixes — you get a 400 Syntax error. This is a Microsoft Graph limitation, not a client bug.

**Workaround**: Use `$filter` instead of `$search` when you need to combine sender and recipient filters. `$filter=from/emailAddress/address eq '...'` works reliably for exact sender match.

**Self-sent emails** (user emailing themselves as reminders): Best found by listing the `sentitems` folder (`GET /me/mailFolders/sentitems/messages`).

## 3. Draft-First Workflow

The recommended safety pattern for any email agent:

1. **Compose the draft** — create the email as a draft, never send directly
2. **Present to the user** — show subject, recipients, and body for review
3. **Send only on explicit approval** — the user must say "send," "send now," or equivalent
4. **Archive stale drafts** — after confirming a send, cross-check Drafts against Sent Items to clean up duplicates

**(MCP)**: `email-agent-mcp` enforces draft-first via send allowlists (empty by default) and the `create_draft` → `send_draft` two-step flow.

### Reply Thread Detection

Before creating any draft with "Re:" or "RE:" in the subject:

1. Search inbox for the original message (by sender + subject keywords)
2. Get the original message ID
3. Create the draft as a reply to that message ID

A standalone draft that should be a reply breaks conversation threading in the recipient's inbox. If the original message cannot be found, flag it to the user rather than silently creating a standalone draft.

**(MCP)**: `reply_to_email` handles threading automatically via RFC message-ID headers.

## 4. Token Efficiency

Email bodies can be enormous (HTML newsletters, forwarded chains). Control token consumption:

| Lever | Effect |
|-------|--------|
| Request markdown format | Converts HTML to markdown, dramatically reducing tokens vs raw HTML |
| Request only needed fields | e.g., subject, sender, date for triage — skip body entirely |
| Cap body length | Limit to ~4000 chars for initial reads |
| Use preview mode | Lightweight body fetch; escalate to full only when needed |

**Triage pattern**: First pass — list emails without bodies. Second pass — preview bodies on the important ones. Full read only when needed.

**(MCP)**: `list_emails` supports a `fields` parameter; `read_email` supports `body_format: "markdown"` and `body_max_chars`.

## 5. Pagination

Both listing and searching return paginated results. When processing large inboxes:

- Use the cursor/nextLink from each response to get the next page
- Process in batches to stay within context limits — don't fetch all pages upfront
- For large-scale operations (cleanup, migration), paginate with a page size of 50

**(MCP)**: `list_emails` returns a `cursor` field for continuation. `search_emails` handles `@odata.nextLink` internally.

## 6. Folder Awareness

Common Outlook folders:

| Folder | Well-known name | Use |
|--------|----------------|-----|
| Inbox | `inbox` | Default for listing/searching |
| Sent Items | `sentitems` | Check what was already sent, find self-emails |
| Drafts | `drafts` | Manage draft lifecycle |
| Archive | `archive` | Archived mail |
| Junk Email | `junkemail` | Spam review |

Custom folders require name-to-ID resolution. Use `$filter=displayName eq '{name}'` on `/me/mailFolders` to resolve.

**Gotcha**: `GET /me/mailFolders?$top=100` returns only root-level folders. Child folders require recursive traversal via `/mailFolders/{id}/childFolders`.

## 7. Folder Management

| Operation | REST API | Notes |
|-----------|----------|-------|
| List folders | `GET /me/mailFolders?$top=100` | Root only; recurse childFolders for nested |
| Create folder | `POST /me/mailFolders` with `{"displayName": "..."}` | Optionally under a parent: `POST /me/mailFolders/{parentId}/childFolders` |
| Move email | `POST /me/messages/{id}/move` with `{"destinationId": "<folder-id>"}` | POST, not PATCH |
| Delete folder | `DELETE /me/mailFolders/{id}` | Rejects system folders (inbox, sentitems, etc.) |

**Gotchas**:
- `$select` does NOT work on PATCH requests — returns 400. Only use `$select` on GET.
- The `move` endpoint is a POST, not a PATCH.
- Outlook uppercases `senderContains` values in storage — this is cosmetic, matching is case-insensitive.

**(MCP)**: `list_folders`, `create_folder`, `move_to_folder`, and `delete_folder` tools handle ID resolution and pagination automatically.

## 8. Inbox Rules

Server-side rules that run on Microsoft's servers (not client-side):

| Operation | REST API |
|-----------|----------|
| List rules | `GET /me/mailFolders/inbox/messageRules` |
| Create rule | `POST /me/mailFolders/inbox/messageRules` |
| Delete rule | `DELETE /me/mailFolders/inbox/messageRules/{id}` |

### Rule Security Model

**High-risk actions (block or gate):**
- `forwardTo`, `forwardAsAttachmentTo`, `redirectTo` — could exfiltrate email
- `delete`, `permanentDelete` — data loss

**Safe actions:**
- `moveToFolder` — move to a folder ID
- `copyToFolder` — copy to a folder ID
- `markAsRead` — mark as read
- `markImportance` — set importance level
- `stopProcessingRules` — prevent cascade to later rules

### Common Conditions

- `fromAddresses` — match by sender email
- `subjectContains` — match words in subject
- `senderContains` — partial sender match
- `headerContains` — match email headers

### Rule Ordering

The `sequence` field controls priority. Specific rules (e.g., meeting booking notifications) must fire before broad rules (e.g., any `noreply@` sender). Always set `stopProcessingRules: true` to prevent cascade.

**Auth scope**: Rules require `MailboxSettings.ReadWrite`. If the OAuth token was issued before this scope was added, the user needs to re-consent.

**(MCP)**: `list_inbox_rules`, `create_inbox_rule`, and `delete_inbox_rule` tools validate conditions and block dangerous actions.

## 9. Calendar Integration

When an email requires scheduling a meeting:

| Operation | REST API |
|-----------|----------|
| Find free time | `POST /me/calendar/getSchedule` |
| Create event | `POST /me/events` |

Default timezone to `America/New_York` unless the user specifies otherwise. Common recurrence patterns: `weekly`, `daily`, `monthly on day 15`, `every 2 weeks`.

**(MCP)**: `find_free_time` and `add_calendar_event` tools wrap these endpoints.

## 10. Attachments

- **Reading**: `GET /me/messages/{id}/attachments` returns attachment metadata and content
- **Drafting with attachments**: Include file paths in the draft; the MCP or API call handles upload
- **Size limits**: Graph API accepts up to 4MB inline; larger files require an upload session

## 11. Composing Drafts via REST

`POST /me/messages` creates a draft. Include `toRecipients`, `subject`, `body` (with `contentType: "HTML"` or `"Text"`), and optionally `attachments`.

For replies, use `POST /me/messages/{id}/createReply` to maintain threading. This preserves the conversation ID and In-Reply-To headers.

Whether using REST or MCP, always create a draft first and let the user review before sending.

## 12. Frontmatter Auto-Enrichment

When using file-based draft workflows, the MCP auto-appends `draft_id` and `draft_link` to the file's YAML frontmatter after saving to Outlook. Agents should:

- NOT pre-populate `draft_id` or `draft_link` — these are write-back fields
- Expect the file to be mutated after the save call
- Use `draft_link` to give the user a clickable URL to review in Outlook web
