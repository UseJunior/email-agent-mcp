## Why

The OAuth verification compositor now defines the required evidence and can
reject placeholders, but the authentic footage still depends on an operator
manually coordinating Terminal, a browser, native screen recording, a
dedicated Gmail mailbox, and eight correctly named capture files. That is
error-prone at precisely the point where an accidental notification, exposed
credential, cut consent interaction, wrong package version, or unsupported
tool claim can invalidate Google's review evidence.

The public npm release is also part of the evidence. The currently published
`email-agent-mcp@0.1.9` predates the `gmail.modify` scope change, so recording it
would contradict the submitted configuration even if the hosted broker asks
for the narrower scope. A repeatable shooting workflow must verify the public
artifact before it opens the camera.

## What Changes

- Add an operator-controlled macOS recording director under
  `tools/oauth-verification-video/` with a Node.js state machine and a thin
  AppleScript adapter.
- Open and arrange a clean Terminal and browser, execute only fixed
  non-sensitive commands, and create separately named recordings for the
  storyboard's authentic capture IDs.
- Keep Google account selection, passwords, MFA, consent, send/reply
  confirmation, and revocation as explicit human actions.
- Demonstrate the real hosted-broker flow and the public
  `email-agent-mcp call` interface for Gmail list, search, read, thread, send,
  and reply operations; do not use an autonomous agent as the required proof.
- Add preflight gates for the dedicated review mailbox, exact published
  package version, narrow-scope artifact, production broker readiness, local
  recording tools, clean capture destinations, and operator safety checks.
- Generate a real-video shot script, exact terminal commands, narration, and
  pause/resume instructions from the same capture requirements used by the
  compositor.
- Make capture ingestion validate the usable duration after `inMs`, support a
  reviewed narration track in final output, and document local credential
  removal plus Google grant revocation.

## Impact

- New capability: `oauth-live-recording`
- Affected code: `tools/oauth-verification-video/`
- Affected docs: the video operator guide and public Gmail
  disconnect/revocation guidance
- Runtime packages and broker behavior are unchanged
- Operational dependency: recording remains blocked until the production Web
  OAuth client, broker, persistence service, custom domain, and a post-#140
  public CLI release are live
- Security: the director never receives Google credentials or automates
  affirmative consent; recordings, state, temporary command results, and
  narration media remain gitignored
