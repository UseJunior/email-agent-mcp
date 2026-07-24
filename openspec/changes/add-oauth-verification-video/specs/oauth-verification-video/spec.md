## ADDED Requirements

### Requirement: Modular review storyboard

The system SHALL define the OAuth verification-video timeline as small,
composable scene modules driven by a declarative storyboard, with shared visual
components kept separate from scene-specific content.

#### Scenario: Editor changes one review scene

- **WHEN** an editor changes the timing, capture reference, or narration for
  one review step
- **THEN** the change is made in that scene's manifest entry or renderer
- **AND** unrelated scene implementations do not need to be rewritten

### Requirement: Authentic evidence boundary

The system SHALL distinguish generated presentation graphics from authentic
product evidence and SHALL NOT allow a final render while a required
interactive capture is absent, represented by a placeholder, or supplied as a
static image.

#### Scenario: Storyboard is rendered before recording

- **WHEN** required authentic captures have not yet been recorded and the
  compositor runs in storyboard mode
- **THEN** it renders conspicuously watermarked capture-instruction cards
- **AND** the output identifies itself as not for submission

#### Scenario: Final render contains a placeholder

- **WHEN** a required capture is absent or a placeholder in final mode
- **THEN** validation fails before video encoding
- **AND** identifies the capture ID and recording instruction

#### Scenario: Interactive proof is supplied as a screenshot

- **WHEN** an OAuth or scope-dependent product-use capture is configured as a
  static image in final mode
- **THEN** validation fails because authentic motion evidence is required

### Requirement: Final review attestations

The system SHALL require explicit project-state and safe-capture attestations
before producing a final submission video.

#### Scenario: Production project contains an uncovered OAuth client

- **WHEN** the declared production OAuth-client inventory contains a client
  that is not covered by the review story
- **THEN** final validation fails and identifies the uncovered client

#### Scenario: OAuth client inventory has not been audited

- **WHEN** the operator has not confirmed the production OAuth-client
  inventory or has not supplied the Web client's non-secret client ID
- **THEN** final validation fails before capture media is encoded

#### Scenario: Capture safety has not been confirmed

- **WHEN** the operator has not confirmed use of a dedicated test mailbox,
  absence of exposed secrets and unrelated mail, and configuration consistency
- **THEN** final validation fails before reading or encoding capture media

### Requirement: Deterministic local rendering

The system SHALL render the storyboard at an explicit resolution, frame rate,
and timeline position using a local Chromium-compatible browser, then encode
the captured frames with ffmpeg without adding a production workspace
dependency.

#### Scenario: Same manifest is rendered twice

- **WHEN** the same project manifest and capture media are rendered twice with
  the same browser and ffmpeg versions
- **THEN** scene timing, visible text, and selected capture frames are
  identical

### Requirement: Reviewer companion artifacts

The system SHALL generate the shot checklist, narration script, and subtitle
timings from the same storyboard used to render the video.

#### Scenario: Scene timing changes

- **WHEN** an editor changes a scene's start or duration
- **THEN** regenerated checklist and subtitle timings reflect the new timeline
- **AND** no independent timestamp document needs manual synchronization

### Requirement: Sensitive media isolation

The system SHALL keep authentic captures, extracted frame caches, and rendered
outputs outside version control by default.

#### Scenario: Operator places a recording in the capture directory

- **WHEN** a recording or rendered artifact is created in the documented local
  media directories
- **THEN** repository ignore rules prevent it from being staged accidentally
