# Google OAuth verification runbook

This runbook prepares the hosted `email-agent-mcp` Gmail OAuth client for
Google production publishing and restricted-scope verification. It contains no
client credentials.

Last audited: 2026-07-23.

## Known project and deployment state

| Item | Audited value |
|---|---|
| Google Cloud project | `email-agent-mcp-gmail` |
| Project number | `160133826181` |
| Project owner | `steven@usejunior.com` |
| Gmail API | Enabled |
| Cloud billing | Enabled |
| Hosted broker origin | `https://oauth.usejunior.com` |
| OAuth callback | `https://oauth.usejunior.com/api/callback` |
| Requested Gmail scope | `https://www.googleapis.com/auth/gmail.modify` |
| Product homepage | `https://usejunior.com/products/email-agent-mcp` |
| Privacy policy | `https://usejunior.com/privacy_policy` |
| Terms | `https://usejunior.com/terms` |

At the audit date, Vercel project
`use-junior/email-agent-mcp-oauth-broker` exists and has the audited non-secret
broker origin, scope, KV requirement, and ticket TTL variables. It does not yet
have its OAuth credentials, Redis, production deployment, or custom domain
attached, so public broker routes still return `DEPLOYMENT_NOT_FOUND`. Complete
those gates and a successful broker OAuth smoke before moving the OAuth app to
production or recording the demo.

The repository defaults to `gmail.modify`. A deployed broker with an explicit
`GMAIL_OAUTH_SCOPES` value must set it to the same scope.

## Pre-submission gates

- [ ] Restore the broker deployment and attach
      `https://oauth.usejunior.com` to it.
- [ ] Attach Redis and set `BROKER_REQUIRE_KV=true` in production.
- [ ] Set `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`,
      `BROKER_PUBLIC_ORIGIN=https://oauth.usejunior.com`, and
      `GMAIL_OAUTH_SCOPES=https://www.googleapis.com/auth/gmail.modify`.
- [ ] Confirm `POST /api/sessions` reaches the application rather than a
      Vercel deployment error.
- [ ] Complete an end-to-end hosted-broker Gmail authorization and refresh
      smoke with a test account, then verify the released CLI can list, search,
      read, and retrieve a thread and can send a message and reply.
- [ ] Inventory Google Auth Platform > Clients. Leave exactly one production
      OAuth client in this project: a Web application client for the hosted
      broker with callback URI
      `https://oauth.usejunior.com/api/callback`. Move or remove desktop,
      development, and test clients before submission.
- [ ] In Google Auth Platform > Data Access, select `Email client` and
      `Email productivity`; leave backup/takeout and reporting/monitoring
      unselected.
- [ ] Verify `usejunior.com` in Google Search Console using the same Google
      account that owns the Cloud project.
- [x] Confirm the public privacy policy includes the email-agent-mcp
      Google-data disclosures and Limited Use statement.
- [x] Confirm the product homepage visibly links to that same privacy-policy
      URL.
- [ ] Review rate limiting, abuse monitoring, secret rotation, token scrubbing,
      incident response, and user-data deletion before the security assessment.

## Google Auth Platform values

Use these values in project `email-agent-mcp-gmail`:

| Field | Value |
|---|---|
| App name | `email-agent-mcp` |
| User support email | `steven@usejunior.com` |
| Homepage | `https://usejunior.com/products/email-agent-mcp` |
| Privacy policy | `https://usejunior.com/privacy_policy` |
| Terms of service | `https://usejunior.com/terms` |
| Authorized domain | `usejunior.com` |
| Developer contact | `steven@usejunior.com` |
| Audience | External |
| Data-access scope | `https://www.googleapis.com/auth/gmail.modify` |

The app name, logo, homepage identity, consent screen, and demo recording must
match. Keep a separate Google Cloud project for development/testing rather than
adding test-only clients or scopes to this production project.

## Ready-to-review scope justification

> email-agent-mcp is an open-source, locally run MCP server that lets a user
> connect their own Gmail account to an AI agent they control. The product
> lists, searches, and reads messages, threads, and attachments; creates,
> updates, and sends drafts; sends new messages; and sends replies within
> existing threads.
>
> `gmail.modify` is the narrowest single scope that supports this implemented
> combination of reading existing Gmail content and composing and sending
> messages. `gmail.readonly` cannot send messages, while `gmail.compose` and
> `gmail.send` cannot read existing message content. The application does not
> immediately or permanently delete Gmail messages and therefore does not
> request `https://mail.google.com/`.
>
> Gmail API calls and message content travel directly between the user's local
> email-agent-mcp process and Google. UseJunior's hosted OAuth broker performs
> authorization-code exchange and token refresh only; it does not call Gmail
> APIs or receive email content.

Edit the text if the product behavior or requested scope changes. Google may
ask for separate explanations of read and compose/send behavior.

## Demo video script

Record against a dedicated test mailbox with the consent screen language set
to English:

1. Show the public product homepage and its privacy-policy link.
2. Show Google Auth Platform > Clients with the single production Web client
   and its client ID, then show Data Access with `gmail.modify`, `Email client`,
   and `Email productivity`.
3. Start `email-agent-mcp configure --provider gmail --mailbox <test-account>`.
4. Show the browser redirect to the same app name and branding configured in
   Google Auth Platform.
5. Record the complete consent screen in English with the requested permission
   visible.
6. Finish consent and show the CLI reporting the connected Gmail address.
7. Against synthetic test messages, demonstrate `list_emails`,
   `search_emails`, `read_email`, `get_thread`, `send_email`, and
   `reply_to_email`, confirming the sent message and reply in Gmail.
8. Explain that message content bypasses the hosted broker and that the local
   token can be removed by deleting the mailbox token file and revoking the
   grant in the user's Google Account.

Do not demonstrate or claim label, read-state, folder, or Trash behavior: the
Gmail provider does not currently expose those mutations. Draft and attachment
footage may be added after those paths pass a live end-to-end smoke; the minimum
script above proves the read and compose/send permission categories directly.

Upload the recording to an unlisted URL accessible to Google's reviewers.
Avoid displaying client secrets, refresh tokens, unrelated inbox contents, or
other personal data.

## Privacy-policy facts to add

The public privacy policy needs an email-agent-mcp section that accurately
covers at least these facts. Treat this as implementation input for legal
review, not as final legal language:

- **Access and purpose:** with the user's OAuth consent, the local application
  accesses Gmail messages, threads, drafts, attachments, and system labels
  solely to provide the user-requested list, search, read, attachment, draft,
  reply, and send features.
- **Local storage:** the refresh token and mailbox configuration are stored on
  the user's machine under `~/.email-agent-mcp/tokens/`.
- **Hosted broker:** the broker receives the authorization code and OAuth
  tokens only to complete authorization and refresh. A ready token ticket may
  be held in Redis until one-time pickup or the short session expiry; refresh
  tokens sent to `/api/refresh` are not persisted.
- **Email-content path:** the hosted broker does not receive or store Gmail
  message content. Gmail API traffic is direct from the user's machine to
  Google.
- **User-selected agents:** email content returned through MCP is delivered to
  the user's chosen MCP client or AI service under that provider's terms; it is
  not sent to an AI model selected by UseJunior.
- **No secondary use:** UseJunior does not sell Gmail data, use it for
  advertising, or use it to train generalized AI models.
- **Service providers:** identify Vercel and whichever Redis provider is
  selected and attached before production as processors of the short-lived
  OAuth session and tokens.
- **Deletion and revocation:** explain how users delete local credentials,
  revoke Google access, and request deletion of any support or operational data.
- **Limited Use:** state that use and transfer of Google user data complies with
  the Google API Services User Data Policy, including its Limited Use
  requirements.

The final public text must match the deployed data flow and retention settings.

## Submission and security assessment

After the pre-submission gates:

1. In Google Auth Platform, confirm Branding, Audience, Clients, and Data Access.
2. Move the app from Testing to In production.
3. Select Prepare for verification.
4. Submit the scope justification and demo video.
5. Monitor the owner/editor inbox for reviewer questions.
6. When Google initiates the restricted-scope security review, complete the
   assigned CASA assessment and retain the Letter of Validation.
7. Track annual re-verification and security reassessment as recurring
   operational work.

Current Google references:

- [Verification requirements](https://support.google.com/cloud/answer/13464321)
- [Submitting an app for verification](https://support.google.com/cloud/answer/13461325)
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Security assessment](https://support.google.com/cloud/answer/13465431)
