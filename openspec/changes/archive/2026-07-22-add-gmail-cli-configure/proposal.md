## Why

The repository now supports Gmail mailbox loading from stored refresh tokens, but the CLI still rejects `email-agent-mcp configure --provider gmail` and the wizard still describes Gmail as a manual-only path. This leaves the advertised multi-provider architecture incomplete and forces users to create token files by hand.

## What Changes

- Add an interactive Gmail configure flow behind `email-agent-mcp configure --provider gmail`
- Use a localhost OAuth callback flow with PKCE to obtain Gmail refresh tokens from a Google OAuth client
- Persist Gmail mailbox metadata under `~/.email-agent-mcp/tokens/` using the mailbox email as the canonical storage key
- Auto-add the authenticated Gmail address to the send allowlist, matching the Microsoft configure path
- Update the wizard and CLI docs so Gmail is presented as an available interactive provider instead of "coming soon" or manual-only

## Impact

- Affected specs: `cli`, `mailbox-config`, `provider-gmail`
- Affected code: `packages/email-mcp`, `packages/provider-gmail`
- User-visible behavior: `configure` and first-run wizard can complete Gmail setup without manual token file editing
