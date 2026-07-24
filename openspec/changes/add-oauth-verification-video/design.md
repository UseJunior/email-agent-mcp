## Context

Google requires evidence of the authentic authorization flow and implemented
scope-dependent behavior. Generated UI recreations are useful for titles,
callouts, and pacing, but cannot substitute for those recordings. The
compositor therefore needs two deliberately different modes:

- `storyboard` may render missing-capture cards so the timing and script can be
  reviewed before infrastructure and OAuth setup are complete.
- `final` accepts only real media files and fails if any review gate remains
  unconfirmed.

The repository should not gain a browser automation dependency in its
production workspaces merely to render a one-off operations artifact.

## Goals

- Keep scenes, shared visual components, timeline data, and rendering code in
  small modules.
- Render the same result deterministically for a given manifest.
- Make it difficult to submit synthetic or unsafe evidence accidentally.
- Keep video tooling isolated from npm workspaces and deployment bundles.
- Produce a useful storyboard before the production OAuth flow is available.

## Non-Goals

- Automating Google account credentials, consent, or Cloud Console mutations.
- Generating synthetic Gmail or consent-screen footage for the final video.
- Uploading the finished video to YouTube.
- Adding Gmail label, read-state, folder, or deletion support.
- Recording unrelated OAuth clients. The production project should instead
  contain only the Web client being submitted; development clients belong in a
  separate project.

## Decisions

### Data-driven scenes

`src/storyboard.mjs` is the single timing and copy source. Each scene names a
small renderer exported from `src/scenes/`, and capture scenes refer to a
capture ID from `project.example.json`. Shared DOM helpers live in
`src/components/`.

This makes editorial changes local and avoids a single generated file similar
to the 1,700-line animation example that motivated this change.

### Dependency-free browser control

`scripts/render.mjs` launches a Chromium-compatible binary with
`--remote-debugging-pipe`. A small `ChromePipe` module sends CDP commands over
the inherited pipe, so the repository does not need Playwright or Puppeteer.
The renderer seeks the page with `window.renderAt(milliseconds)` and captures
one deterministic PNG per output frame. ffmpeg encodes those frames to
H.264/yuv420p.

The browser path and ffmpeg path can be overridden. The renderer also searches
common macOS/Linux installation and Playwright-cache locations for developer
convenience.

### Authentic capture handling

Capture media is stored in a gitignored `captures/` directory. Before browser
rendering, ffmpeg normalizes each referenced clip into a local frame cache.
The browser scene displays the appropriate decoded frame inside the branded
capture shell.

In storyboard mode, absent captures become conspicuous cards containing the
exact recording instruction. In final mode, any missing capture is fatal.
Static screenshots are allowed only for explicitly static evidence, such as
the product privacy link; interactive OAuth and product-use scenes require
video.

### Final-mode review gates

Final validation requires:

1. Every required capture exists and has the expected media kind.
2. The declared production OAuth-client inventory contains exactly the Web
   client covered by the video, includes its non-secret client ID, and has been
   explicitly audited by the operator.
3. The operator confirms the footage uses a dedicated test mailbox.
4. The operator confirms no secrets, tokens, or unrelated personal mail appear.
5. The operator confirms the app name, consent language, and requested scope
   match the submitted Google Auth Platform configuration.

These are manifest attestations rather than claims the renderer can infer from
pixels. They make the manual responsibility explicit and auditable.

### Review story

The video demonstrates:

1. Product identity and the public privacy-policy link.
2. `email-agent-mcp configure --provider gmail`.
3. The authentic hosted Web-client OAuth grant, with the requested permission
   visible.
4. Successful connection to the dedicated test mailbox.
5. Direct local Gmail API behavior: list/search/read/thread.
6. Send and reply to the dedicated test mailbox, followed by Gmail UI
   confirmation.
7. Local credential deletion and Google grant revocation guidance.

The required story does not claim label/read-state/Trash functionality until
that behavior exists in the Gmail provider. Draft creation/update/send may be
added as optional evidence only after a real Gmail smoke proves that the Gmail
draft ID and message ID paths work end to end.

## Risks and Mitigations

- **Frame rendering is slower than real-time.** The draft defaults to a lower
  frame rate; final rendering can use 24 or 30 fps.
- **Chromium or ffmpeg is absent.** `doctor` reports exact missing binaries and
  accepts explicit environment overrides.
- **A user marks synthetic footage as authentic.** Final mode requires video
  for interactive scenes and an explicit attestation, while the checklist
  states Google's authenticity requirement.
- **Sensitive content is committed.** Capture and output directories are
  gitignored and tests assert the ignore rules remain present.
- **Runbook and storyboard drift.** The generated checklist derives from the
  scene manifest, and the runbook points to it.

## Open Questions

- Final capture and rendering remain blocked until the production broker,
  custom domain, Redis choice, Web OAuth client, and test-mailbox authorization
  are operational.
- If the existing Desktop OAuth client remains assigned to the production
  Google Cloud project, it must be shown too. The preferred path is to remove
  it from the production project and keep development clients in a separate
  project before recording.
