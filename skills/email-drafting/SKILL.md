---
name: email-drafting
description: >-
  Draft email replies with tone matching, proper threading, and formatting that
  survives email clients. Use when user says "draft a reply," "respond to this
  email," "write an email," "compose a response," "email reply," "tone match,"
  "professional email," "follow-up email," or "thank you email." Covers voice
  calibration, formatting gotchas, and the draft-first safety pattern.
license: Apache-2.0
compatibility: >-
  Works with any agent. No runtime dependencies — instruction-only skill.
  Optionally enhanced by email-agent-mcp (Node.js >=20) for draft saving
  and thread detection.
metadata:
  author: UseJunior
  version: "0.1.0"
---

# Email Response Drafting

This skill covers drafting email replies that sound human, thread correctly, and render properly across email clients. It is scoped to response drafting — not marketing campaigns or mass outreach.

## Draft-First: The Non-Negotiable Rule

Never send an email without the user's explicit approval. The workflow:

1. **Compose** the draft (in markdown, in the agent's chat, or in a file)
2. **Present** recipients, subject, and body to the user for review
3. **Save as draft** to Outlook (or the user's email client) if available
4. **Wait** for the user to say "send," "send now," "reply now," or equivalent
5. **Send** only after explicit approval

If intent is ambiguous ("looks good" could mean "I approve the draft" or "I'll send it myself"), ask for one-line confirmation before sending.

## Voice and Tone Matching

The cardinal rule: match the sender's register.

| Relationship | Tone | Example opener |
|-------------|------|----------------|
| Internal team / contractors | Short, direct, no filler | "Sent the updated file. Let me know if anything looks off." |
| Existing clients (high trust) | Warm but efficient | "Quick update — the document is ready for your review." |
| New contacts / cold replies | Professional, value-first | Lead with what is relevant to them, not your credentials |
| Formal threads | Match their formality | If they write "Dear Steven," reply with "Dear [Name]," not "Hey!" |

### Calibration signals

Read the sender's email for cues:
- **Length** — if they wrote 2 sentences, don't reply with 5 paragraphs
- **Greeting style** — mirror their "Hi" / "Hello" / "Dear" / no greeting
- **Closing** — mirror their "Best" / "Thanks" / "Regards" / no closing
- **Emoji/exclamation use** — match their energy level, don't exceed it

### What to avoid

- **Over-explaining process** — state the outcome, not the journey. "The agreement is ready" beats "I reviewed the agreement, made several updates to sections 3 and 7, cross-referenced with our template library, and..."
- **Filler phrases** — "I hope this email finds you well" is noise. Start with the point.
- **Quoting others on your own product** — never attribute your product description to someone else
- **Singling out one insight from a rich conversation** — if you had a long call, reference the breadth of the discussion, don't cherry-pick

## Threading: Get It Right

Broken threading looks unprofessional. Before creating a reply draft:

1. **Check the subject** — if it has "Re:" or "RE:", this is a reply to an existing thread
2. **Find the original message** — search by sender + subject keywords
3. **Get the message ID** — use it as the `in_reply_to` or `reply_to` parameter
4. **Create a threaded reply** — not a standalone new message

If the original message cannot be found, tell the user rather than silently creating a standalone draft that will break the thread in the recipient's inbox.

**REST API**: Use `POST /me/messages/{id}/createReply` to maintain threading. This preserves conversation ID and In-Reply-To headers.

**MCP**: `reply_to_email` handles threading automatically.

## Structure: One Ask Per Email

Every email should have exactly one clear action item. If you need multiple things, either:

- Pick the most important one and save the rest for a follow-up
- Use a numbered list where the first item is the ask and the rest are context

**Structure template for action-needed replies:**

```
[1-2 sentence context/update]

[The ask — what you need from them, by when]

[Optional: supporting detail they might need to act]
```

**Structure template for informational replies:**

```
[The news — what happened or what's ready]

[Optional: what they should do next, or "no action needed"]
```

## Formatting That Survives Email Clients

Email rendering is a minefield. Markdown that looks perfect in a text editor can break in Outlook, Gmail, or Apple Mail.

### Gotchas

| Issue | What breaks | Fix |
|-------|------------|-----|
| **Cuddled lists** | No blank line before first `- item` | Always add a blank line before the first list item |
| **Raw markdown in HTML** | `**bold**` renders as literal asterisks in HTML email | Convert markdown to HTML before sending |
| **Missing plain-text body** | HTML-only emails get flagged by spam filters | Always include both HTML and plain-text versions |
| **Signature placement** | Signature appears before the quoted thread | Put signature after reply body, before the quoted thread |
| **Long URLs** | URLs wrap mid-word and break clickability | Use hyperlink text `[click here](url)` in markdown; convert to `<a>` in HTML |
| **Tables** | Many email clients don't render markdown tables | Use HTML `<table>` with inline styles for email |

### Character encoding

- Curly quotes (`\u201c\u201d`) and straight quotes (`"`) should both be handled
- Em dashes (`\u2014`) render fine in modern clients but may break in plain-text
- Non-ASCII characters in subject lines need proper encoding (most APIs handle this)

## Draft File Format

When saving drafts to files (for MCP or manual review), use YAML frontmatter:

```yaml
---
to: recipient@example.com
subject: Re: Project update
in_reply_to: <message-id-from-original>
---

Body of the email in markdown.

The MCP or send script converts this to HTML + plain text automatically.
```

Do not pre-populate `draft_id` or `draft_link` — these are auto-appended by the MCP after saving to Outlook.

## Tone Calibration by Context

### Delivering good news
Lead with the news. "The document is signed and filed" — then details if needed.

### Delivering bad news
Lead with empathy, then the fact, then the path forward. "I understand the timeline is tight. The review is taking longer than expected — we should have it by Thursday. I will send it as soon as it is ready."

### Following up (no response yet)
Soft-remind the agreed action, don't re-ask. "Circling back on the agreement — let me know if you need anything to move forward." Not: "Did you get my last email?"

### Declining or redirecting
Be direct and offer an alternative. "I'm not the right person for this, but [Name] at [Company] specializes in exactly this."

## Feedback

If this skill helped, star us on GitHub: https://github.com/UseJunior/email-agent-mcp
On ClawHub: `clawhub star stevenobiajulu/email-response-drafting`
