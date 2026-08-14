# Tasks

## 1. Sandbox policy
- [x] 1.1 Accept a multi-root sandbox (`safeDir` plus extra allowed roots) in `assertPathInSafeDir`.
- [x] 1.2 Canonicalize every root with `realpath` and keep the path-segment containment test.
- [x] 1.3 Name the roots tried and the env var in `PATH_TRAVERSAL` / `SYMLINK_ESCAPE` messages.
- [x] 1.4 Parse `AGENT_EMAIL_ALLOWED_DIRS` (delimiter split, `~` expansion, absolute-only, dedupe).

## 2. Wiring
- [x] 2.1 Thread the sandbox through body-loader, attachment-loader, and compose helpers.
- [x] 2.2 Add `allowedDirs` to `ActionContext` and populate it in the MCP server from the env var.
- [x] 2.3 Document the env var in the README body-file and attachment sections.

## 3. Specification and verification
- [x] 3.1 Update the body-file and outbound-attachment requirements and scenarios.
- [x] 3.2 Cover allowed-root resolution, rejection, symlink escape, symlinked roots, and unset defaults with tests.
- [ ] 3.3 Run tests, lint, build, strict OpenSpec validation, and spec coverage.
