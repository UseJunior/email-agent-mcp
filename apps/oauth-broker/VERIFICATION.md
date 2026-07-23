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

At the audit date, all public broker routes returned Vercel
`DEPLOYMENT_NOT_FOUND`, and the authenticated `use-junior` Vercel team showed
no projects. Restore the deployment and complete a successful broker OAuth
smoke before moving the OAuth app to production or recording the demo.

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
      smoke with a test account.
- [ ] Confirm the OAuth client is a Web application client with the exact
      callback URI `https://oauth.usejunior.com/api/callback`.
- [ ] Verify `usejunior.com` in Google Search Console using the same Google
      account that owns the Cloud project.
- [ ] Add the email-agent-mcp Google-data disclosures below to the public
      privacy policy after legal review.
- [ ] Make the product homepage link visibly to that same privacy-policy URL.
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
> lists, searches, and reads messages; creates, updates, and sends drafts and
> replies; changes read/star/label state; and moves messages to folders,
> including soft deletion by moving a message to Gmail Trash.
>
> `gmail.modify` is the narrowest scope that supports this implemented feature
> set. `gmail.readonly` cannot create drafts, send messages, or change message
> and label state. `gmail.compose` and `gmail.send` cannot read and organize the
> mailbox. The application does not immediately or permanently delete Gmail
> messages and therefore does not request `https://mail.google.com/`.
>
> Gmail API calls and message content travel directly between the user's local
> email-agent-mcp process and Google. UseJunior's hosted OAuth broker performs
> authorization-code exchange and token refresh only; it does not call Gmail
> APIs or receive email content.

Edit the text if the product behavior or requested scope changes. Google may
ask for separate explanations of read, compose/send, and modification features.

## Demo video script

Record against a dedicated test mailbox with the consent screen language set
to English:

1. Show the public product homepage and its privacy-policy link.
2. Start `email-agent-mcp configure --provider gmail`.
3. Show the browser redirect to the same app name and branding configured in
   Google Auth Platform.
4. Record the complete consent screen with the requested permission visible.
5. Finish consent and show the CLI reporting the connected Gmail address.
6. Demonstrate the user-facing features that require the scope:
   list/search and read a test message; create/update a draft; modify a label or
   read state; move a test message to Trash; and send a message to the same test
   account.
7. Explain that message content bypasses the hosted broker and that the local
   token can be removed by deleting the mailbox token file and revoking the
   grant in the user's Google Account.

Upload the recording to an unlisted URL accessible to Google's reviewers.
Avoid displaying client secrets, refresh tokens, unrelated inbox contents, or
other personal data.

## Privacy-policy facts to add

The public privacy policy needs an email-agent-mcp section that accurately
covers at least these facts. Treat this as implementation input for legal
review, not as final legal language:

- **Access and purpose:** with the user's OAuth consent, the local application
  accesses Gmail messages, threads, drafts, attachments, and labels solely to
  provide the user-requested read, search, organize, draft, reply, and send
  features.
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
- **Service providers:** identify the infrastructure providers that process the
  short-lived OAuth session and tokens, currently Vercel and the attached Redis
  provider.
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
