---
name: outlook-email
description: >-
  Manage Outlook and Microsoft 365 email with AI agents — triage inbox by sender
  trust, draft replies with tone matching, organize folders, create inbox rules,
  and monitor for priority messages. Use when user says "check my email," "triage
  inbox," "organize email," "email cleanup," "outlook folders," "inbox rules,"
  "draft a reply," "email summary," "unread messages," "email heartbeat," or
  "monitor my mailbox." Works with any Graph API client; optionally enhanced by
  the open-source email-agent-mcp server.
license: Apache-2.0
homepage: https://github.com/UseJunior/email-agent-mcp
compatibility: >-
  Works with any agent or client that can call the Microsoft Graph API on
  the user's behalf. Requires a Microsoft 365 OAuth delegated token with
  the scopes listed below. The reference runtime (email-agent-mcp, open
  source, Apache-2.0) uses MSAL device code flow, requires Node.js >=20,
  and persists tokens in the OS keychain.
requires:
  credentials:
    provider: microsoft-graph
    auth: oauth2-delegated
    reference_flow: oauth2-device-code (MSAL, via @azure/identity)
    scopes_read_minimum:
      - Mail.Read
      - offline_access
    scopes_write:
      - Mail.ReadWrite
      - MailboxSettings.ReadWrite
    scopes_sensitive:
      - Mail.Send
    reference_runtime_scope_set:
      - Mail.Read
      - Mail.ReadWrite
      - Mail.Send
      - MailboxSettings.ReadWrite
      - User.Read
      - offline_access
    token_storage: >-
      Reference runtime (email-agent-mcp) stores OAuth tokens in the OS
      keychain via MSAL with @azure/identity-cache-persistence. No raw
      passwords, no plain text token files. Other clients should use their
      platform's secure storage.
  environment_variables:
    - name: AGENT_EMAIL_CLIENT_ID
      required: false
      description: Override the default Microsoft App ID used for auth
    - name: AGENT_EMAIL_SEND_ALLOWLIST
      required: false
      description: Path to JSON file listing recipients allowed for send_email (empty by default — blocks all sends)
    - name: EMAIL_AGENT_MCP_HOME
      required: false
      description: Override default config and token storage directory (~/.email-agent-mcp)
  network:
    runtime:
      - graph.microsoft.com
      - login.microsoftonline.com
  filesystem:
    - draft markdown files (optional, client-dependent)
  enforcement:
    draft_first: layered
  out_of_scope:
    - calendar_integration
metadata:
  author: UseJunior
  version: "0.1.7"
---

# Outlook Email Management

> 使用 AI 代理管理 Outlook 邮件

Patterns for AI agents working with Microsoft 365 / Outlook email. These patterns work with any Graph API client. For a turnkey MCP server with safety guardrails, see [email-agent-mcp](https://github.com/UseJunior/email-agent-mcp) (open source, Apache-2.0).

## Safety Model
> 安全模型

**Draft-first is the recommended default for enterprise email.** Agents should never send email without explicit user approval.

The workflow:

1. **Compose** — create the email as a draft
2. **Present** — show recipients, subject, and body to the user
3. **Wait for approval** — only send when the user says "send," "send now," or equivalent
4. **Clean up** — after confirming a send, archive stale duplicate drafts

Why this matters: a single wrong send — wrong recipient, wrong attachment, confidential content to the wrong thread — can cause real damage. Drafts are free. Mistakes are expensive.

**email-agent-mcp** enforces this via concrete runtime guardrails:

- **Empty send allowlist by default** — agents cannot send email until the user explicitly configures allowed recipients
- **Action-level blocks** on dangerous inbox rule actions: `forwardTo`, `forwardAsAttachmentTo`, `redirectTo`, `delete`, `permanentDelete` ([rules.ts:39](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/email-core/src/actions/rules.ts#L39))
- **`delete_email` disabled by default** unless the caller explicitly opts in with `user_explicitly_requested_deletion: true` ([label.ts](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/email-core/src/actions/label.ts))

**NemoClaw** can enforce it at the network policy level — see the [NemoClaw Email Policy skill](#related-skills).

## Trust Boundary: What This Skill Can and Cannot Enforce

Before you install or grant OAuth consent, understand where the safety boundary lies.

**This skill is instruction-only.** It ships no code, executes nothing by itself, and cannot enforce any of the safety protections described in the Safety Model above or the Authentication section below. Everything is enforced (or not enforced) by whichever runtime actually executes the Microsoft Graph API calls. The skill file is a set of instructions; the runtime is the sandbox.

### What that means in practice

- The draft-first workflow, send allowlist, and inbox-rule action blocks are properties of the reference runtime [`email-agent-mcp`](https://github.com/UseJunior/email-agent-mcp), not of this skill. If you use a different runtime, those protections are not automatically present.
- `Mail.Send` and `Mail.ReadWrite` are high-impact OAuth scopes. Granting them without a runtime that enforces draft-first and send-allowlist gives up the primary mitigations.
- `MailboxSettings.ReadWrite` controls inbox rules, and inbox rules can forward or redirect mail externally. The reference runtime blocks dangerous rule actions at the action handler level, but that protection is runtime-specific.
- Autonomous invocation (where the agent runs this skill without per-call approval) is a platform-level setting, not something the skill controls. Combined with write scopes, it increases the surface area of any runtime weakness.

### Before installing or granting consent

This skill requests high-impact Microsoft Graph scopes (`Mail.ReadWrite`, `MailboxSettings.ReadWrite`, optionally `Mail.Send`). Review the items below before you grant consent. They are the exact things to check; the skill cannot enforce any of them for you.

1. **Only grant `Mail.Send` if you trust the runtime** to honor draft-first. The skill itself cannot enforce "draft first, send second" — that's a runtime property. Verify your runtime either (a) blocks direct send by default, or (b) is `email-agent-mcp` which ships with an empty send allowlist by default.
2. **Only grant `MailboxSettings.ReadWrite` if you trust the runtime** to block dangerous rule actions (`forwardTo`, `forwardAsAttachmentTo`, `redirectTo`, `delete`, `permanentDelete`). The reference runtime does this at [`rules.ts:39`](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/email-core/src/actions/rules.ts#L39) — inspect the code yourself. Alternatively, prefer `MailboxSettings.Read` if rule auditing is all you need.
3. **Prefer least-privilege consent.** Start with `Mail.Read` + `offline_access` for read-only triage. Escalate to write scopes only as specific workflows require them. Skip `Mail.Send` entirely if draft-first (user sends manually from Outlook) is acceptable.
4. **Review the client app identity.** Whatever `AGENT_EMAIL_CLIENT_ID` resolves to is the Azure AD application you are consenting to. Check the consent screen, verify the app name and publisher, and make sure the requested scopes match what you see in this document.
5. **Test on a non-production account first.** Be prepared to revoke OAuth consent and invalidate refresh tokens at https://myaccount.microsoft.com/consent if anything looks wrong or misconfigured.
6. **Avoid enabling autonomous invocation** for this skill unless you understand and trust the runtime's guardrails. Autonomous invocation combined with `Mail.Send` or `MailboxSettings.ReadWrite` gives the agent the ability to send mail or create inbox rules without per-call user approval — only safe if the runtime enforces the mitigations described above.

## Authentication & Required Scopes
> 身份验证与所需权限

This skill operates against Microsoft Graph and requires an OAuth 2.0 delegated access token for a Microsoft 365 account.

### Minimum scopes by use case

| Use case | Scopes required |
|----------|----------------|
| Read-only triage and summarization | `Mail.Read`, `offline_access` |
| Create drafts and move email | + `Mail.ReadWrite` |
| Create and delete inbox rules | + `MailboxSettings.ReadWrite` |
| Send email directly (not draft-first) | + `Mail.Send` — **sensitive, see below** |

`MailboxSettings.Read` alone is insufficient for rule management; Microsoft requires `MailboxSettings.ReadWrite` in practice to read some rule state. The reference runtime requests `MailboxSettings.ReadWrite` directly.

### Reference runtime scope set (email-agent-mcp)

The open-source reference runtime [`email-agent-mcp`](https://github.com/UseJunior/email-agent-mcp) requests all six of the following scopes up front via MSAL device code flow:

```
Mail.Read
Mail.ReadWrite
Mail.Send
MailboxSettings.ReadWrite
User.Read
offline_access
```

`User.Read` is requested by the reference runtime only — it is used by the CLI to fetch `/me` and persist the authenticated mailbox address to config. A generic Graph client does not need `User.Read` unless it performs the same profile lookup.

Source: [`packages/provider-microsoft/src/auth.ts:14`](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/provider-microsoft/src/auth.ts#L14)

### Token storage

The reference runtime stores OAuth tokens in the OS keychain (macOS Keychain / Windows Credential Manager / Linux libsecret) via MSAL with `@azure/identity-cache-persistence`. No raw passwords. No plain text token files. Refresh tokens are handled silently by MSAL.

If using a different client, use your platform's secure secret storage. Do not store Graph tokens in `.env` files committed to repos.

### Risk mapping — scopes to exfiltration risk

| Scope | Enables | Risk if misused |
|-------|---------|----------------|
| `Mail.Read` | Read any message, attachment, and header | Read-only; no exfiltration beyond what the agent session can already see |
| `Mail.ReadWrite` | Create drafts, move/copy messages, mark read | Low on its own; combined with `Mail.Send` enables outbound |
| `MailboxSettings.ReadWrite` | Create and delete inbox rules | **HIGH** — malicious rules with `forwardTo`/`redirectTo` can exfiltrate mail silently even after the session ends |
| `Mail.Send` | Send email from the user's account | **HIGH** — unauthorized outbound mail, impersonation risk |
| `User.Read` | Read user profile basics (email, display name) | Low; metadata only |
| `offline_access` | Refresh tokens without re-auth | Low on its own; extends the blast radius of any other scope if the token is stolen |

The reference runtime mitigates the two HIGH-risk scopes with concrete controls — see the enforcement layers below.

### Draft-first: layered enforcement

Draft-first is the recommended workflow for all runtimes. Enforcement is layered — this skill describes the policy, and the runtime enforces it:

| Layer | Enforcement mechanism |
|-------|----------------------|
| **Reference runtime (email-agent-mcp)** | Send allowlist empty by default. Action-level blocks on `forwardTo`, `forwardAsAttachmentTo`, `redirectTo`, `delete`, `permanentDelete` in [`rules.ts:39`](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/email-core/src/actions/rules.ts#L39). `delete_email` disabled by default in [`label.ts`](https://github.com/UseJunior/email-agent-mcp/blob/main/packages/email-core/src/actions/label.ts). |
| **Network policy (NemoClaw)** | Can block `graph.microsoft.com/v1.0/me/sendMail` at the network layer via custom policy, eliminating send capability entirely |
| **Raw Graph API client** | Instruction-level only. Relies on the agent honoring the draft-first instructions. **Not recommended for safety-critical use** — pair with one of the runtime layers above |

The reference runtime layer is the strongest: it catches mistakes at the action handler, not just at the instruction layer. Publicly verifiable in the linked source files.

### Hardening recipes for high-risk environments

1. **Use `email-agent-mcp` with an empty send allowlist.** Already the default. Agents cannot send without explicit recipient configuration.
2. **Don't grant `Mail.Send`.** Scope-level mitigation — makes direct send impossible. The user sends from Outlook manually after reviewing drafts.
3. **Don't grant `MailboxSettings.ReadWrite`.** Removes the ability to create inbox rules at all. Rule auditing still works if you grant `MailboxSettings.Read` separately.
4. **Layer NemoClaw.** See the [NemoClaw Email Policy skill](#related-skills) to block send endpoints at the network layer regardless of scope grants.

### Calendar integration is out of scope

This skill references calendar events as one possible communication channel (for example, "create a calendar event for an action item with a deadline"), and `references/outlook-graph-patterns.md` §9 documents the calendar Graph endpoints for reference. However, calendar integration is **not part of this skill's core scope set** — the reference runtime does not request `Calendars.*` scopes. Use a separate calendar skill if you need calendar automation.

## Email Triage
> 邮件分类

Not all email is equally important. Triage by sender trust, not by arrival order:

| Priority | Who | Action |
|----------|-----|--------|
| 1 - Immediate | Paying customers, active clients | Surface and summarize right away |
| 2 - Prompt | Engaged contacts, active threads | Surface promptly |
| 3 - Colleagues | Internal team, contractors | Surface promptly |
| 4 - Batch | Newsletters, automated notifications | Batch for later review |
| 5 - Deprioritize | Unknown senders | Default low priority |

**Exception lane**: Unknown senders may be elevated if they have objective evidence — replying to an existing thread, matching a known client domain, referencing a real calendar event, or reporting a credible security event (not self-claimed urgency).

**Anti-pattern**: Treating all unread email as equally important. A marketing newsletter with "URGENT" in the subject is not urgent. Self-claimed urgency from unknown senders is unreliable signal.

For the full triage model with anti-patterns and exception criteria, see the [Zero-Trust Email Triage skill](#related-skills).

## Email Drafting
> 邮件起草

When drafting replies:

- **Match the sender's tone** — if they wrote "Dear Steven," reply with "Dear [Name]," not "Hey!"
- **State the outcome, not the journey** — "The document is ready for your review" beats "I processed the document through our pipeline and..."
- **One clear ask per message** — don't bury the action item in paragraph three
- **Check threading** — if the subject has "Re:" or "RE:", find the original message and create a threaded reply, not a standalone draft

**Formatting gotchas** agents get wrong:

| Issue | Fix |
|-------|-----|
| Cuddled lists (no blank line before `- item`) | Always add a blank line before the first list item |
| Markdown in HTML email | Convert markdown to HTML before sending; raw `**bold**` renders as literal asterisks |
| Missing plain-text body | Always include both HTML and plain-text versions |
| Signature placement | Put the signature after the reply body, before the quoted thread |

For the complete drafting guide with tone calibration by relationship type, see the [Email Drafting skill](#related-skills).

## Inbox Organization
> 收件箱整理

Two levers for inbox control:

**One-time cleanup**: Scan recent inbox, identify the noisiest automated senders, create folders, batch-move existing emails.

**Ongoing rules**: Create server-side Outlook rules via Graph API to auto-sort future mail. Rules run on Microsoft's servers — they work even when no agent is running.

The workflow:

1. **Scan** — fetch recent inbox emails, count by sender, sort descending
2. **Categorize by action** — not by sender type:
   - Glance, don't act: CI notifications, build alerts, DMARC reports
   - Read when time allows: newsletters, marketing
   - Archive for records: receipts, invoices, payment confirmations
   - May need action: meeting bookings, security alerts
3. **Create folders** — 5-9 folders covers most inboxes. More and they stop getting checked.
4. **Move existing email** — batch-move matching messages to the new folders
5. **Create rules** — auto-sort future mail. Set `stopProcessingRules: true` to prevent cascade.
6. **Re-sweep** — rules only apply to future mail. After creating a rule, move existing matches too.

**Gotcha**: Meeting notifications (e.g., HubSpot booking confirmations) look like newsletters because of `noreply@` prefixes. Create a meeting-specific rule with a lower sequence number, or the generic newsletter rule will swallow them.

For the full cleanup workflow with Graph API gotchas and battle-tested patterns, see the [Inbox Cleanup skill](#related-skills).

## Email Heartbeat
> 邮件心跳检查

Three tiers of mailbox monitoring:

| Tier | Frequency | What to check |
|------|-----------|---------------|
| **Light** | Every 15-30 min | Unread count from priority senders only |
| **Deep** | Every 2-4 hours | Full triage pass — new unread from all senders, summarize by priority tier |
| **Digest** | Daily | End-of-day summary — what came in, what was handled, what needs follow-up |

**Light check pattern**:
1. List unread emails from priority sender domains
2. If any found, surface a one-line summary per email
3. If none, stay silent — no "no new email" noise

**Deep check pattern**:
1. List all unread emails
2. Classify by sender trust tier
3. Summarize Tier 1-2 emails individually
4. Batch Tier 3-5 into a count ("12 newsletters, 3 GitHub notifications")

**Digest pattern**:
1. List all emails received today
2. Group by: handled (replied/read), needs follow-up, informational
3. Highlight any Tier 1-2 emails that haven't been responded to

## Communicating Results to the User

Different users prefer different channels for email updates:

| Channel | When to use |
|---------|------------|
| **Chat interface** | Default. Summarize inline in the conversation. |
| **Text message** | If the user prefers distilled updates via messaging. Provide copy-paste text with phone number if no SMS tool is available. |
| **Calendar event** | For action items with deadlines — create an event instead of a reminder email. |
| **Summary email** | Only if explicitly requested. Be aware this adds to inbox clutter. |

Ask on first use — don't assume the user wants email summaries delivered by email.

## Gotchas That Will Bite You
> 常见陷阱

**Graph API `$search` cannot combine `from:` + `to:` KQL prefixes** — you get a 400 Syntax error. Use `$filter` instead when combining sender and recipient filters.

**`$select` does not work on PATCH requests** — returns 400 "OData request not supported." Only use `$select` on GET.

**Move is a POST, not a PATCH** — `POST /me/messages/{id}/move` with `{"destinationId": "<folder-id>"}`.

**Self-sent emails** are best found by listing `sentitems`, not searching inbox.

**Root-only folder listing** — `GET /me/mailFolders` returns only root-level folders. Child folders require recursive traversal via `/mailFolders/{id}/childFolders`.

**Inbox rule ordering** — `sequence` controls priority. Specific rules must fire before broad ones.

**Rules require `MailboxSettings.ReadWrite` scope** — if the OAuth token predates this scope, the user needs to re-consent.

For the complete reference with REST API patterns, pagination, attachments, and calendar integration, see [references/outlook-graph-patterns.md](./references/outlook-graph-patterns.md).

## Related Skills

Focused skills for specific email workflows:

- **Zero-Trust Email Triage** (`email-triage`) — sender-trust-based prioritization with exception lane for unknown senders
- **Email Response Drafting** (`email-drafting`) — tone-matching, formatting gotchas, thread detection
- **Inbox Cleanup & Rules** (`email-cleanup`) — folder management, Graph API rules, battle-tested cleanup workflow
- **NemoClaw Email Policy** (`nemoclaw-email-policy`) — network-level policy enforcement for email agents

Install a focused skill:
```
clawhub install stevenobiajulu/zero-trust-email-triage
clawhub install stevenobiajulu/email-response-drafting
clawhub install stevenobiajulu/inbox-cleanup-outlook
clawhub install stevenobiajulu/nemoclaw-email-policy
```

## Feedback

If this skill helped, star us on GitHub: https://github.com/UseJunior/email-agent-mcp
On ClawHub: `clawhub star stevenobiajulu/outlook-email-management`
