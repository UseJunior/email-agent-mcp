## Context

`update_draft` currently decides how to PATCH a body by inspecting the body HTML for a quoted-history boundary. Every shipped variant of that inspection has been wrong in a way that silently damages the draft. The question this design answers is not "which marker should we match" but "how do we stop matching markers at all".

## Decision: reply-draft detection is provider-level, not body-level

The system SHALL determine whether a draft is a reply from provider metadata, not by searching the body for a divider.

Microsoft Graph knows how a draft was created. A draft made by `createReply` / `createReplyAll` carries conversation linkage (`conversationId` together with an in-reply-to relationship on the underlying message) that a fresh `createDraft` does not. That signal is authoritative, stable across correspondent clients, and unaffected by Gmail's `m_<digits>` prefixing, Exchange's `x_` prefixing, or Outlook mobile using a different container element entirely.

### Alternatives considered

**Tolerate prefixed markers (`x_`, `m_<digits>`).** Rejected. It narrows the failure window without closing it: the prefix set is open-ended, and it does not address Outlook-mobile drafts, where the first `divRplyFwdMsg` in the document can be nested *inside* the quoted history. Splitting there deletes the outer quoted layers — a worse outcome than the bug being fixed.

**Cache the original body at draft creation and diff on update.** Rejected. It makes the tool stateful across calls, and it is unsound for drafts the tool did not create — one edited by hand in Outlook web or mobile has no cached baseline.

**Keep splitting but validate the result.** Rejected. There is no reliable post-condition to check: a split that silently drops one quoted layer produces a body that still looks well-formed.

## Decision: warn on reply-subject changes rather than refusing

Renaming a reply draft is legitimate and needed. The threading risk is real but conditional — clients that group by subject may split the thread — and it is the caller's call to make. The system therefore permits the change and reports the risk through the `warnings` channel.

This is deliberately asymmetric with the body rule. A subject change is visible to the caller in the returned preview and is trivially reversible. A destroyed quoted thread is neither.

## Risks

- **Detection false-negatives.** If a reply draft is not recognised as one, `replace_body: true` would permit a wholesale replace that destroys quoted history. Detection must fail *closed*: when the reply status cannot be determined, treat the draft as a reply and refuse the body edit.
- **Breaking existing callers.** Any caller currently passing `body` to `update_draft` on a reply draft will now get an error. This is intended; both previous outcomes were silent corruption.

## Accepted risk: the origin stamp proves a value, not authorship

Peer review observed that neither stamp is cryptographically bound to this application. Any client with draft-write access to the mailbox can set the Gmail `X-Agent-Draft-Origin` header or the Graph extended property, so a forged `non_reply` on a genuine reply draft would permit a destructive replacement.

This is accepted rather than mitigated. An actor able to write that stamp already holds write access to the draft and can replace or delete its body directly; routing the same damage through this tool grants no additional capability, so there is no privilege escalation to defend against. The alternative — an authenticated, draft-bound stamp — introduces secret management, rotation, and cross-installation key distribution to defend against an adversary who already has the power in question.

The realistic failure is collision rather than attack: another benign tool using the same marker name. A namespaced property identifier and a vendor-prefixed header make that unlikely, and a conflicting or duplicated stamp resolves to `indeterminate` rather than to whichever value happens to be read first.

Revisit if the threat model changes — specifically if drafts ever become writable by a principal that is not already trusted with the mailbox.
