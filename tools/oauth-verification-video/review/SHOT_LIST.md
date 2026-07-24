# Google OAuth verification shot list

> Generated from `src/storyboard.mjs`. Do not edit timestamps here.
>
> Final footage must show authentic interactions. Animation is used only for framing, labels, and the data-flow explanation.

## 00:00:00–00:00:07 — Email Agent MCP

Generated title scene; no authentic capture required.

Narration: This video demonstrates the production Email Agent MCP OAuth client and the Gmail features enabled by the requested permission.

## 00:00:07–00:00:25 — Product identity & privacy

Capture ID: `identity`

Record usejunior.com/products/email-agent-mcp, click its privacy link, and show the Google-data section.

Narration: Email Agent MCP is an open-source, locally run email client and productivity integration. Its public homepage links directly to the privacy policy and Google-data disclosures.

## 00:00:25–00:00:47 — Production client & requested scope

Capture ID: `auth-platform`

Record Google Auth Platform Clients and Data Access. Show only the production Web client and its non-secret client ID; show gmail.modify and the Email client + Email productivity selections. Never reveal the client secret.

Narration: The production project contains the hosted Web OAuth client. Data Access requests gmail.modify and identifies the product as an email client and email productivity application.

## 00:00:47–00:00:58 — OAuth broker, direct Gmail data path

Generated architecture scene; no authentic capture required.

Narration: The hosted broker exchanges authorization codes and refreshes tokens. Gmail messages travel directly between the user’s local process and Google; the broker never receives email content.

## 00:00:58–00:01:14 — Configure the distributed CLI

Capture ID: `configure`

Using a clean local profile, record the released CLI version and the configure command through the browser handoff. Do not display environment variables.

Narration: This is the same public CLI users install. Configuration starts the hosted broker authorization flow at oauth.usejunior.com.

## 00:01:14–00:02:19 — Complete, authentic OAuth grant

Capture ID: `oauth-consent`

Continuously record the broker redirect, account chooser, any warning, app branding, expanded permission “Read, compose, and send emails from your Gmail account”, Allow/Continue, broker completion, and return to terminal.

Narration: The user sees the complete Google consent flow in English, including the exact application identity and permission to read, compose, and send Gmail messages. The user explicitly continues before any Gmail access occurs.

## 00:02:19–00:02:29 — Connected test mailbox

Capture ID: `connected`

Record the terminal connection success and email-agent-mcp status for the dedicated review mailbox. Never open the token file.

Narration: Authorization returns to the local CLI, which reports the dedicated synthetic review mailbox as connected.

## 00:02:29–00:03:17 — Search, read & retrieve the thread

Capture ID: `read`

Record list_emails, search_emails, read_email, and get_thread against the seeded EA-MCP REVIEW READ 001 synthetic message.

Narration: List and search return Gmail message metadata. Read retrieves the selected synthetic message, and get thread returns its conversation. Gmail API traffic is direct from this local process.

## 00:03:17–00:04:22 — Compose, send & reply

Capture ID: `send-reply`

Record send_email to the same allowlisted test account, confirm it in Gmail, run reply_to_email, then show the resulting Gmail thread. Do not demo drafts until their Gmail ID path passes a live smoke.

Narration: Email Agent MCP composes and sends a synthetic message through the Gmail API, restricted by the local recipient allowlist. It then sends a threaded reply and confirms the conversation in Gmail.

## 00:04:22–00:04:34 — Content stays out of the broker

Generated architecture scene; no authentic capture required.

Narration: Only authorization codes and OAuth tokens traverse the broker for exchange and refresh. Message bodies stay between the local application and Gmail.

## 00:04:34–00:04:56 — User control & revocation

Capture ID: `revoke`

Record the documented local credential-removal guidance and the Google Account third-party access page for revocation. Do not reveal token-file contents.

Narration: The user can remove local credentials and revoke the application’s access from their Google Account at any time.

## 00:04:56–00:05:04 — One explicit grant. User-directed Gmail actions.

Generated closing scene; no authentic capture required.

Narration: UseJunior does not sell Gmail data, use it for advertising, or use it to train generalized AI models. Thank you for reviewing Email Agent MCP.
