---
name: feedback_thoroughness
description: User strongly prefers thorough, front-loaded planning with certainty before implementation — no shortcuts, no rushing
type: feedback
---

Thoroughness over speed. Front-load difficult work. No shortcuts.

**Why:** User found that stubs were reported as "100% done" via unit test coverage when critical features (watcher) were completely unimplemented. This eroded trust in progress reporting.

**How to apply:**
- Audit for stubs/mocks before claiming completion
- Tests should be tied to specs, not reactive patches
- Use sub-agents for parallel implementation but test everything end-to-end
- "Manually test" means Claude tests it, only escalate to user when human action is required
- Prefer small-scale tests before scaling out
- Commit plans to version control so sub-agents can reference them
- Peer review with other AI agents (Gemini CLI, Codex CLI) before claiming done
- Never say "this should work" — prove it works
- Going slow and getting architecture right saves time long-term
