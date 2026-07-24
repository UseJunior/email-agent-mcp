# Narration script

> Generated from `src/storyboard.mjs`.

- **00:00:00 — Email Agent MCP:** This video demonstrates the production Email Agent MCP OAuth client and the Gmail features enabled by the requested permission.
- **00:00:07 — Product identity & privacy:** Email Agent MCP is an open-source, locally run email client and productivity integration. Its public homepage links directly to the privacy policy and Google-data disclosures.
- **00:00:25 — Production client & requested scope:** The production project contains the hosted Web OAuth client. Data Access requests gmail.modify and identifies the product as an email client and email productivity application.
- **00:00:47 — OAuth broker, direct Gmail data path:** The hosted broker exchanges authorization codes and refreshes tokens. Gmail messages travel directly between the user’s local process and Google; the broker never receives email content.
- **00:00:58 — Configure the distributed CLI:** This is the same public CLI users install. Configuration starts the hosted broker authorization flow at oauth.usejunior.com.
- **00:01:14 — Complete, authentic OAuth grant:** The user sees the complete Google consent flow in English, including the exact application identity and permission to read, compose, and send Gmail messages. The user explicitly continues before any Gmail access occurs.
- **00:02:19 — Connected test mailbox:** Authorization returns to the local CLI, which reports the dedicated synthetic review mailbox as connected.
- **00:02:29 — Search, read & retrieve the thread:** List and search return Gmail message metadata. Read retrieves the selected synthetic message, and get thread returns its conversation. Gmail API traffic is direct from this local process.
- **00:03:17 — Compose, send & reply:** Email Agent MCP composes and sends a synthetic message through the Gmail API, restricted by the local recipient allowlist. It then sends a threaded reply and confirms the conversation in Gmail.
- **00:04:22 — Content stays out of the broker:** Only authorization codes and OAuth tokens traverse the broker for exchange and refresh. Message bodies stay between the local application and Gmail.
- **00:04:34 — User control & revocation:** The user can remove local credentials and revoke the application’s access from their Google Account at any time.
- **00:04:56 — One explicit grant. User-directed Gmail actions.:** UseJunior does not sell Gmail data, use it for advertising, or use it to train generalized AI models. Thank you for reviewing Email Agent MCP.
