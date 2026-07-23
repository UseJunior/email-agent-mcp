## Why

The primary onboarding command, `npx -y email-agent-mcp`, opens the interactive
wizard, but its Gmail path always selects the hosted OAuth broker. Users who
want the currently recommended bring-your-own-key (BYOK) path must leave the
wizard and discover CLI flags or environment variables.

The hosted OAuth app is still in Google's Testing status, so the wizard should
make that path's user cap, unverified-app interstitial, and seven-day refresh
token lifetime explicit while making BYOK available directly.

## What Changes

- Add a Gmail authentication-mode picker to the first-run wizard.
- Keep the hosted default available, with plain language about its current
  Testing-status limitations.
- Let users choose BYOK, link to the repository's Gmail Setup instructions,
  require a Desktop OAuth client, and prompt for both credential halves.
- Collect the client secret with a masked password prompt and never render it
  in wizard output.
- Preserve existing explicit flag/environment behavior and the existing
  reconnect path that reuses saved mailbox credentials.
- Add the Gmail Setup documentation needed by the wizard link.

## Impact

- Affected spec: `cli`
- Affected code: `packages/email-mcp/src/wizard.ts` and its tests
- Affected docs: `README.md`
- User-visible behavior: the Gmail wizard gains one explicit authentication
  choice; Outlook and non-interactive configure flows remain unchanged.
