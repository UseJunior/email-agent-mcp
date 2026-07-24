## Context

Google's verification video must show the submitted application, the complete
English OAuth consent flow, and real use of the requested Gmail permission.
The existing compositor provides generated framing and strict final-mode
attestations, but it intentionally does not capture live interaction.

macOS provides the necessary primitives without adding a GUI automation
dependency:

- Terminal exposes a native AppleScript `do script` command.
- `screencapture` records a display to an explicit file and supports a hard
  duration cap.
- AppleScript can activate applications and open a validated URL.

Browser click automation is deliberately excluded. `System Events` keystrokes
are brittle, require Accessibility access, and would be inappropriate for
passwords, MFA, Google consent, or write confirmation.

## Goals

- Make the authentic shooting session repeatable without making it
  unattended.
- Keep every sensitive or consent-bearing interaction under direct human
  control.
- Ensure the recorded public CLI actually contains the scope behavior being
  submitted for review.
- Prevent recordings from being overwritten, misnamed, truncated, or silently
  accepted.
- Keep the shot script, command sequence, capture IDs, and compositor timeline
  synchronized.

## Non-Goals

- Automating Google credentials, account selection, MFA, consent, or
  revocation clicks.
- Automating Google Cloud Console mutations.
- Recording personal mail or sending to any address other than the dedicated
  review mailbox.
- Using `agy` or another autonomous agent as the primary verification
  evidence.
- Publishing an npm release, provisioning broker infrastructure, uploading to
  YouTube, or submitting the verification request.
- Automatically setting any final-mode operator attestation.

## Decisions

### Node.js owns workflow state; AppleScript is a thin adapter

A Node.js director imports the existing storyboard capture requirements and
owns preflight, shot order, process lifecycle, filenames, duration checks, and
resume state. A small AppleScript receives already-validated commands and safe
URLs as arguments, opens or arranges Terminal and the browser, and presents
human checkpoints.

This keeps parsing, validation, and tests in the repository's normal
JavaScript tooling while using AppleScript only for the macOS integration it
does well. The AppleScript does not interpolate secrets or accept arbitrary
shell text.

### Native Terminal commands instead of simulated typing

The director uses Terminal's `do script` command for known non-sensitive
commands. This makes the exact command and output visible without granting
Accessibility permission or risking input in the wrong window. A rehearsal
mode may instead place an exact command in an operator-facing script for
manual paste when visible typing is editorially preferred.

Environment preparation occurs before recording. The footage never displays
an environment dump, token directory, client secret, access token, refresh
token, password, MFA value, or clipboard contents.

### Explicit, bounded recordings per capture ID

Each authentic scene is recorded to a unique take path below the existing
gitignored capture directory. The director starts native `screencapture` only
after an explicit operator checkpoint, tracks its process, applies a hard
duration cap, and requires an explicit stop. It never overwrites an earlier
take.

After each take, `ffprobe` confirms that a video stream exists and that the
usable duration covers the scene after its configured `inMs`. A take remains
unselected until the operator reviews and accepts it.

The OAuth consent take begins before opening the broker URL and ends only
after the browser returns and Terminal reports a successful connection. It is
one continuous recording.

### Strict broker URL handling

The configure command runs in a clean Terminal and prints the hosted-broker
start URL. If the director opens that URL, it reads only the visible Terminal
output, accepts a URL whose origin and path are exactly
`https://oauth.usejunior.com/api/start`, opens it once, and does not persist it
in workflow state or logs. Any other URL requires the operator to stop.

The user manually completes every Google page. The director can poll whether
the Terminal command is still busy, but it cannot infer or assert that consent
was valid.

### Public artifact gate

Recording configuration names an exact released `email-agent-mcp` version;
`latest` is forbidden. Preflight verifies the version is available publicly
and inspects the installed public artifact and its Gmail provider dependency
for `https://www.googleapis.com/auth/gmail.modify`, while rejecting the legacy
`https://mail.google.com/` scope.

The director also performs a safe broker readiness check before shooting. A
missing release, wrong scope, unavailable custom domain, or incomplete
production configuration blocks recording with a concrete remediation.

### Deterministic Gmail demonstration

The required proof uses `email-agent-mcp call` directly so the reviewer can
see the exact implemented action. The sequence is:

1. `list_emails`
2. `search_emails` for a seeded synthetic subject
3. `read_email`
4. `get_thread`
5. `send_email` to the same dedicated mailbox
6. `reply_to_email` with `reply_all: false`
7. Gmail UI confirmation of the resulting self-thread

Message IDs are read from structured command output rather than copied
manually. Temporary JSON lives below a gitignored work directory. The
director validates that the configured recipient equals the dedicated
mailbox and relies on the local send allowlist; no other recipient is
accepted.

### Operator-authored trust decisions

Preflight and the shot script remind the operator to use a clean English
browser profile, an otherwise empty dedicated mailbox, Focus mode, no
password-manager overlays, and one production Web OAuth client. These are
human confirmations, not facts the script can prove.

The director never writes final attestations such as
`authenticUneditedInteractions`, `noSecretsVisible`, English consent, or
client-inventory audit. Those remain false until the operator reviews the raw
captures and updates the final project manifest.

### Narration and timing follow authentic takes

The generated shot script provides concise narration for each real action.
The operator records narration separately after the picture edit. Final
rendering may mux an explicit reviewed narration file; it does not preserve
unreviewed capture audio by default.

Scene durations are adjusted to the accepted authentic takes instead of
speeding through Google or Gmail interactions. Subtitle timing and the
reviewer checklist continue to derive from the storyboard.

## Risks and Mitigations

- **Screen Recording permission is absent.** A short disposable preflight
  capture detects failure and instructs the operator to grant permission and
  relaunch the invoking app.
- **A recording stops unexpectedly.** The director checks process state,
  probes the output, and retains the failed take without selecting it.
- **A dialog appears in frame.** Checkpoints occur before recording or outside
  the selected crop, and every take requires review.
- **The public package drifts from main.** An exact version and scope-artifact
  gate replace `@latest`.
- **Sensitive data appears despite preparation.** Takes remain local and
  unaccepted until the operator completes the existing no-secrets and
  dedicated-mailbox attestations.
- **Consent automation undermines the evidence.** All Google interactions are
  manual and the continuous OAuth take is never synthesized or cut.
- **The session URL is exposed after use.** It is opened only from strict
  visible output, used once, and never written to workflow state or logs.

## Open Questions

- The exact post-#140 public package version will be selected only after that
  release is published.
- The final display number and selected recording region will be confirmed in
  rehearsal on the operator's Mac.
- Production shooting cannot begin until the broker and sole Web OAuth client
  are live and the prior Google grant has been revoked.
