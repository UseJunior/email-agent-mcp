## ADDED Requirements

### Requirement: Operator-controlled shooting workflow

The system SHALL provide a macOS shooting workflow that resolves every
authentic capture required by the OAuth verification storyboard, records each
capture as a separately reviewable take, and requires an explicit operator
action before recording begins or an accepted take is selected.

#### Scenario: Operator previews the session

- **WHEN** the director runs in dry-run mode
- **THEN** it lists the ordered capture IDs, safe commands, manual actions,
  expected durations, and output paths
- **AND** it does not open applications, start a recording, authenticate, or
  modify mailbox state

#### Scenario: Operator records a take

- **WHEN** the operator confirms a capture is ready
- **THEN** the director starts a bounded native screen recording at a unique
  gitignored path
- **AND** it never overwrites an existing take
- **AND** the take remains unselected until the operator reviews and accepts it

### Requirement: Human OAuth and consent boundary

The system SHALL keep Google account selection, credentials, MFA, consent,
write confirmation, and grant revocation under direct human control and SHALL
NOT simulate clicks or keystrokes for those actions.

#### Scenario: Hosted OAuth begins

- **WHEN** the configure command prints a broker start URL
- **THEN** the director may open it only if its origin and path are exactly
  `https://oauth.usejunior.com/api/start`
- **AND** it does not persist or log the session URL
- **AND** the operator manually completes every Google interaction

#### Scenario: Consent evidence is recorded

- **WHEN** the OAuth-consent take is recorded
- **THEN** recording begins before the broker URL is opened
- **AND** continues without cuts through the complete English Google consent
  flow and explicit human grant
- **AND** ends only after the browser return and Terminal connection result are
  visible

### Requirement: Safe visible command execution

The system SHALL execute only predefined non-sensitive commands through
Terminal's native AppleScript interface and SHALL NOT place secrets, tokens,
passwords, MFA values, or arbitrary operator input into AppleScript, shell
history, the clipboard, or logs.

#### Scenario: Director runs a visible command

- **WHEN** a recording step invokes a CLI command
- **THEN** the exact non-sensitive command is visible in a dedicated Terminal
  window
- **AND** it is executed without `System Events` keyboard simulation
- **AND** failures remain visible and stop the current shot

#### Scenario: Command input contains an unsafe value

- **WHEN** a mailbox, package version, URL, output path, subject, or other
  configured value fails its allowlist or escaping validation
- **THEN** the director refuses to construct or execute the command

### Requirement: Verified public release

The system SHALL require an exact publicly available `email-agent-mcp` release
whose installed Gmail provider uses
`https://www.googleapis.com/auth/gmail.modify` and does not use the legacy
`https://mail.google.com/` scope before authentic recording can begin.

#### Scenario: Published package predates the scope change

- **WHEN** the configured public artifact contains the legacy Gmail scope or
  lacks `gmail.modify`
- **THEN** preflight blocks authentic recording
- **AND** identifies publishing a corrected release as the remediation

#### Scenario: Configuration uses a floating package version

- **WHEN** the configured package version is `latest`, a range, or another
  non-exact selector
- **THEN** preflight rejects it so the recorded artifact is reproducible

### Requirement: Deterministic scope-dependent proof

The system SHALL demonstrate the real Gmail provider through the public
`email-agent-mcp call` interface using list, search, read, thread, send, and
reply operations against a dedicated synthetic review mailbox.

#### Scenario: Read behavior is demonstrated

- **WHEN** the read-evidence step runs
- **THEN** it lists the mailbox, searches for the seeded synthetic subject,
  reads the returned message ID, and retrieves its thread
- **AND** every ID is derived from structured command output

#### Scenario: Write behavior is demonstrated

- **WHEN** the write-evidence step runs
- **THEN** it sends only to the configured dedicated mailbox
- **AND** captures the returned message ID
- **AND** replies to that message with `reply_all` set to false
- **AND** the resulting self-thread is confirmed in the real Gmail UI

#### Scenario: Recipient differs from review mailbox

- **WHEN** a write target does not exactly equal the configured dedicated
  mailbox
- **THEN** the director blocks the operation before invoking the CLI

### Requirement: Recording preflight and media integrity

The system SHALL fail closed before authentic recording unless the required
local tools, screen-recording capability, production broker, dedicated
mailbox, clean output location, and operator safety confirmations are ready.

#### Scenario: Preflight finds a blocker

- **WHEN** a required tool, permission, broker endpoint, mailbox preparation,
  clean-browser confirmation, or output condition is missing
- **THEN** recording does not start
- **AND** preflight reports a concrete remediation without printing sensitive
  configuration

#### Scenario: Recording finishes

- **WHEN** a take process exits
- **THEN** the director verifies that the output contains a video stream
- **AND** verifies that its usable duration after `inMs` covers the target
  scene
- **AND** rejects a missing, truncated, or frozen-tail-prone take

### Requirement: Resumable sensitive-media isolation

The system SHALL keep recordings, temporary structured outputs, local state,
hashes, and narration assets in gitignored directories and SHALL allow a
shooting session to resume without repeating accepted takes.

#### Scenario: Session resumes

- **WHEN** the director reopens an interrupted session
- **THEN** it identifies completed, accepted, failed, and pending capture IDs
- **AND** does not replay a mailbox mutation or replace an accepted take
  without explicit operator action

#### Scenario: State is persisted

- **WHEN** workflow state or diagnostics are written
- **THEN** they contain capture metadata and safe status only
- **AND** exclude OAuth session URLs, message bodies, credentials, tokens, and
  final-mode attestations

### Requirement: Synchronized operator and narration script

The system SHALL generate the real-video shot instructions, exact safe
commands, manual checkpoints, narration copy, and subtitle timing from the
same storyboard and capture requirements used for final rendering.

#### Scenario: Authentic take changes scene duration

- **WHEN** an accepted take requires a longer scene
- **THEN** the storyboard, operator script, narration timing, subtitles, and
  final duration are regenerated together
- **AND** the interaction is not sped up merely to preserve an obsolete
  timeline

#### Scenario: Final narration is added

- **WHEN** an explicit reviewed narration file is configured
- **THEN** final rendering muxes it into the submission output
- **AND** unreviewed audio from raw screen captures remains excluded by default

### Requirement: Attestation independence

The system SHALL NOT automatically assert any final-mode claim about
authenticity, absence of secrets, English consent language, production OAuth
client inventory, or configuration consistency.

#### Scenario: All takes were recorded successfully

- **WHEN** the director completes every required capture
- **THEN** all final review attestations remain unchanged
- **AND** final rendering remains blocked until the operator independently
  reviews the footage and explicitly confirms each required attestation
