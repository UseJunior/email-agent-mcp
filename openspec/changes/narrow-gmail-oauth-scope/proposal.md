## Why

The Gmail provider requests `https://mail.google.com/`, even though its delete
operation only moves messages to trash and it never performs immediate,
permanent deletion. Google reserves that broad scope for apps that require
permanent deletion and requires verification submissions to request the
narrowest scope that satisfies implemented functionality.

`https://www.googleapis.com/auth/gmail.modify` covers the provider's actual
read, compose, send, label, and trash behavior without granting permanent
deletion. Narrowing the scope removes an avoidable OAuth verification blocker.

## What Changes

- Change the Gmail provider's default OAuth scope to `gmail.modify`.
- Change the hosted OAuth broker's default scope to the same value.
- Test both direct/BYOK and broker authorization requests.
- Update Gmail setup and broker deployment documentation.
- Preserve existing refresh-token metadata; new and repeated authorizations
  request the narrower grant.

## Impact

- Affected spec: `provider-gmail`
- Affected code: `packages/provider-gmail` and `apps/oauth-broker`
- Affected docs: root Gmail setup and provider/broker READMEs
- Operational note: deployments that explicitly set `GMAIL_OAUTH_SCOPES` must
  update that environment value before verification submission.
