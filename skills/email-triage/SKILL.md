---
name: email-triage
description: >-
  Zero-trust email triage — prioritize inbox by sender trust tier, not arrival
  order. Surfaces paying customers immediately, batches newsletters, and applies
  an exception lane for unknown senders with objective evidence. Use when user
  says "triage my inbox," "prioritize email," "what's important," "check for
  urgent email," "email priority," "sender trust," "inbox zero," or "which
  emails matter." Works with any email client or Graph API tool.
license: Apache-2.0
homepage: https://github.com/UseJunior/email-agent-mcp
compatibility: >-
  Instruction-only skill — no runtime dependencies. Provides prioritization
  logic that works with whatever email data the agent's runtime already
  exposes. Does not require the skill to declare or request any credentials.
  This skill does not instruct the agent to fetch additional data sources
  it doesn't already have access to.
metadata:
  author: UseJunior
  version: "0.1.2"
---

# Zero-Trust Email Triage

AI is fast enough that if it sees an email, it can respond quickly. The failure mode is not slow response — it is surfacing noise that drowns out real signal. This skill teaches agents to classify email by sender trust, not by arrival order or self-claimed urgency.

## The Problem

Most email agents treat all unread email as equally important. This creates two failure modes:

1. **Noise escalation** — a marketing email from an unknown sender with "URGENT" in the subject gets surfaced alongside a client asking for help
2. **Buried signal** — a partner reply sits unread for days because it arrived between 50 GitHub notifications

Both failures damage trust. The fix is sender-based prioritization.

## Primary Classifier: Sender Trust Tiers

Classify every email by who sent it, not what it says:

### Tier 1 — Paying Customers and Active Clients
Surface immediately. These are relationships where a missed email damages trust and revenue.

**Examples**: Client asking for a document review, customer reporting a bug, partner requesting a meeting.

**Action**: Summarize and surface to the user right away. If the email requires a response, flag it as action-needed.

### Tier 2 — Engaged Contacts
Surface promptly. These are people the user has active conversations with — not yet paying, but the relationship has momentum.

**Examples**: Prospect who attended a demo last week, collaborator on an open-source project, investor in active due diligence.

**Action**: Include in the next triage summary. Don't delay more than one triage cycle.

### Tier 3 — Known Colleagues and Team
Surface promptly but don't interrupt for routine messages.

**Examples**: Internal team updates, contractor status reports, automated reports from known internal systems.

**Action**: Include in triage summary. Flag only if the message is time-sensitive or requires a decision.

### Tier 4 — Newsletters and Automated Notifications
Batch for later. These are legitimate but not time-sensitive.

**Examples**: GitHub CI notifications, npm advisories, industry newsletters, marketing emails from vendors the user has a relationship with.

**Action**: Count and categorize. "12 newsletters, 8 GitHub notifications, 3 marketing emails." Don't summarize each one individually.

### Tier 5 — Unknown Senders
Deprioritize by default. Most unsolicited email is noise.

**Examples**: Cold outreach, event invitations from strangers, "partnership opportunity" pitches.

**Action**: Mention only if the user explicitly asks about unread email from unknown senders, or if the exception lane (below) applies.

## Exception Lane: When Unknown Senders Get Elevated

Unknown senders may be elevated from Tier 5 if — and only if — they present objective evidence in signals the agent already has access to:

| Evidence class | Why it matters |
|----------------|---------------|
| **Thread continuity** | The message is a reply within an existing thread the user started |
| **Known-domain match** | The sender's domain matches a customer or partner already on the priority list |
| **Externally corroborated reference** | The message references a concrete event (meeting, deadline) that is independently verifiable in another signal the agent already has |
| **Trusted forward** | The message is a forward or introduction from someone on the priority list |
| **Authenticated system notification** | The message originates from a verified system sender for an infrastructure event (billing, security) — not generic account-warning phishing |

The agent should only rely on these signals if its runtime already provides access to them. **This skill does not instruct the agent to fetch additional data sources it doesn't already have.**

### What Does NOT Constitute Evidence

- **Self-claimed urgency** — "URGENT," "time-sensitive," "act now" from an unknown sender is social engineering, not urgency
- **Name-dropping** — "I know your colleague John" without John being on the thread
- **Impressive titles** — "VP of Strategy at FutureCorp" means nothing if FutureCorp is unknown
- **"Register now while space is available!"** — event marketing disguised as urgency

## Anti-Patterns Agents Get Wrong

### Passing along marketing urgency
An unknown sender writes: "Last chance to register for our AI summit — spots filling fast!"

**Wrong**: Surface as potentially important because it mentions AI (the user's industry).
**Right**: Tier 5. Unknown sender, self-claimed urgency, no objective evidence. Ignore unless user asks.

### Treating unread count as a metric
An agent reports: "You have 47 unread emails" and lists them all.

**Wrong**: Every email gets equal treatment.
**Right**: "2 client emails need your attention. 45 others batched (18 newsletters, 12 GitHub, 15 cold outreach)."

### Urgency theater from known senders
An internal colleague writes: "URGENT: please review the updated slide deck."

**Wrong**: Escalate because of "URGENT" in the subject.
**Right**: Tier 3 (known colleague). Surface promptly in the triage summary. The user decides if a slide deck review is actually urgent.

## Implementing Triage

### Step 1 — Build the priority sender list

Before the first triage run, ask the user (or infer from existing data):
- Which domains are paying customers?
- Which email addresses are active contacts?
- Any VIP addresses that should always be Tier 1?

If using a CRM or customer directory, pull domains from there.

### Step 2 — First pass: list without bodies

Fetch recent unread emails with only metadata fields (sender, subject, date, read status). Don't fetch bodies yet — this keeps the first pass fast and token-efficient.

### Step 3 — Classify by tier

Match each email's sender against the priority list. Apply the tier classification.

### Step 4 — Second pass: preview priority emails

For Tier 1-2 emails only, fetch a body preview (first ~500 chars). Summarize the key point and any action needed.

### Step 5 — Report by tier

Present results grouped by tier, not chronologically:

```
## Priority emails (2)
- [Client] Sarah at AcmeCorp: "Can you send the updated agreement?" → needs reply
- [Partner] Dave at PartnerFirm: "Confirming Thursday meeting" → informational

## Batched (37)
- 12 GitHub notifications
- 8 newsletters  
- 17 cold outreach / unknown
```

## Feedback

If this skill helped, star us on GitHub: https://github.com/UseJunior/email-agent-mcp
On ClawHub: `clawhub star stevenobiajulu/zero-trust-email-triage`
