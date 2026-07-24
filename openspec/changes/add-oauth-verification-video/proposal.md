## Why

Google's restricted-scope review requires an end-to-end video that shows the
real OAuth grant and the product functionality enabled by the requested scope.
The current runbook describes the shots, but it does not provide a repeatable
way to assemble them, prevent placeholder footage from leaking into the final
submission, or keep the visual treatment readable as the review story changes.

The runbook also asks the recording to demonstrate Gmail label/read-state and
Trash mutations that the current Gmail provider does not expose. Its Gmail
draft read-back path also needs a real-mailbox verification before it can be
trusted on camera. A reviewer video must describe only implemented,
live-verified behavior.

## What Changes

- Add a dependency-free, modular HTML/CSS/JavaScript compositor under
  `tools/oauth-verification-video/`.
- Define the review story as data: scene modules reference a capture manifest
  rather than embedding timing and copy in one large animation file.
- Add a deterministic renderer that drives headless Chromium over its DevTools
  pipe and encodes frames with ffmpeg.
- Support a clearly watermarked storyboard mode while making final mode fail
  closed when required authentic captures, client-inventory confirmation, or
  safe-capture attestations are missing.
- Generate a reviewer shot checklist and narration/subtitle script from the
  same scene manifest used by the renderer.
- Correct the verification runbook so it requires the dependable Gmail
  read/search/thread, send, and reply behavior, without claiming unsupported
  mailbox mutations or unverified draft behavior.

## Impact

- New capability: `oauth-verification-video`
- Affected code: `tools/oauth-verification-video/` only; no runtime package or
  broker dependency is added
- Affected docs: `apps/oauth-broker/VERIFICATION.md`
- Operational impact: final footage must still be captured manually against
  the production Web OAuth client and a dedicated test mailbox
- Security: source captures and rendered output remain gitignored; final
  validation requires an operator attestation that no credentials, tokens, or
  unrelated mailbox data are visible
