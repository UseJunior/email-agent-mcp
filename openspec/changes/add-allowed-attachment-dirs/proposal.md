# Add Operator-Allowlisted File Roots

## Why

`body_file` and `attachments[].path` resolve against a single root
(`EMAIL_MCP_SAFE_DIR`, default the process working directory) with no way to
declare additional trusted directories. Attaching a document that lives in
`~/Downloads`, a cloud-storage mount, or a shared drive therefore forces one of
two bad options: inline the file as `base64` (pushing hundreds of KB of encoded
text through the agent's context) or copy it into the working directory, which
routinely means staging a confidential document inside a git working tree.

The sandbox itself is worth keeping as the default — without containment, an
unrestricted `path` would let a restricted agent read files through the server
that it could not read directly (a confused-deputy escalation). The missing
piece is an opt-in escape hatch the operator, not the caller, controls.

## What Changes

- Accept `AGENT_EMAIL_ALLOWED_DIRS`: a delimiter-separated list of absolute
  directories (leading `~` expanded) that `body_file` and `attachments[].path`
  may also resolve within.
- Resolve a caller path against the safe directory first, then each configured
  root in order; the first containment match wins.
- Canonicalize every root with `realpath` before containment, so an allowlisted
  root that is itself a symlink is resolved to its real location and a symlink
  escaping every root is still rejected.
- Name the roots that were tried, and the env var that widens them, in the
  rejection message.
- Unset configuration preserves today's behavior exactly.

## Impact

- Affected specs: `email-write`, `email-attachments`
- Affected code: `email-core` safe-path policy, body/attachment loaders,
  compose helpers, action context; `email-mcp` server env wiring; README
