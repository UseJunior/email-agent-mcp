- [x] Add recording configuration, schemas, gitignore coverage, and a dry-run
  command that resolves the storyboard's authentic capture IDs
- [x] Add the Node.js recording state machine and thin AppleScript adapter for
  Terminal/browser activation, safe command execution, and human checkpoints
- [x] Add bounded `screencapture` lifecycle management, unique take filenames,
  ffprobe validation, explicit take acceptance, and resumable local state
- [x] Add strict hosted-broker URL extraction and one-time opening without
  persisting or logging the session URL
- [x] Add public-release, narrow-scope artifact, broker-readiness, dedicated
  mailbox, and recording-permission preflight gates
- [x] Add the deterministic list/search/read/thread/send/reply demonstration
  with dynamic message IDs, same-mailbox enforcement, and `reply_all: false`
- [x] Generate the real-video operator script, exact pasteable commands,
  narration, and manual security checkpoints from the storyboard
- [x] Validate usable capture duration after `inMs`, lengthen scenes from
  accepted takes, and support muxing an explicit reviewed narration track
- [x] Add public local credential-removal and Google grant-revocation guidance
- [x] Add unit tests for command construction, URL allowlisting, public
  artifact checks, state transitions, non-overwrite behavior, duration
  validation, and attestation isolation
- [x] Run `openspec validate add-oauth-live-recording-director --strict`,
  focused tests, repository validation, and a no-recording dry run
- [ ] After the post-#140 release and production broker are ready, rehearse
  with the dedicated mailbox and record the eight authentic captures
- [ ] Review every raw take for secrets and continuity, record narration,
  render final output, and run final-mode validation without auto-setting any
  attestation
