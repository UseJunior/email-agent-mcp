---
name: Codex Implement
description: Delegate a well-scoped GitHub issue to Codex CLI (headless, in an isolated worktree), then peer-review the diff with agy + Codex before opening the PR. Mandatory peer-review gate before merge. Repo-agnostic — auto-detects repo, conventions, and build commands.
category: Meta
tags: [delegate, codex, headless, peer-review, worktree, github]
args: "<issue-number>"
---

You are running the `/codex-implement` workflow. The user wants you to delegate implementation of a GitHub issue to Codex CLI in headless mode, supervise the result, run a mandatory two-reviewer peer review (agy + Codex) on the diff, and then open a PR with auto-squash armed.

You are the **supervisor**, not the implementer. Codex writes the code; you write the prompt, validate the diff, gate on peer review, and ship.

Codex is highly capable on implementation — including large, multi-file, technically complex changes. Don't gate on raw complexity. Gate on workflow correctness (epic/spec/ambiguity) and on the kind of judgment that requires the user's own experience.

> **⚠️ Deprecated invocation warning.** Do NOT use `codex exec --full-auto`. That code path (and any backgrounded `codex exec` invoked without an explicit stdin redirect) blocks reading stdin and **hangs forever** when there's no TTY attached — the process never exits, `run_in_background` never notifies you, and you're left with a silently-stuck review or implementation run. Every `codex exec` call in this skill uses `--sandbox workspace-write` (or `--sandbox read-only` for read-only reviews) plus a mandatory `< /dev/null` redirect. Do not drop the redirect even when a call "looks" foreground — background scheduling can happen transparently.

## When to use

- The issue has concrete acceptance criteria you can articulate as a target output.
- You can name the files most likely to change (so Codex doesn't have to hunt).
- You have a clean working tree (or saved/committed the changes you'd lose).

## When to reserve for the user instead of delegating

- **Edge-case judgment from a decade of practice.** The issue's correct solution depends on long-tail scenarios Codex will over-normalize away ("there are only five cases" when the user can trivially name a sixth from real-world experience). Includes regulatory practice nuances, customer-specific institutional knowledge, and rare-but-load-bearing edge conditions.
- **Non-formally-verifiable outcomes.** The success criterion is taste, voice, or positioning — product copy, brand voice, ICP framing, sales-narrative phrasing. Codex optimizes against verifiable targets; subjective ones drift.
- **Real-world experience the long tail Codex can't find documented.** Even with web search, the answer lives in the user's head from years of working a domain. Surface to the user.
- **Workflow gates** (independent of Codex's capability):
  - `epic`-labelled issues — break into scoped sub-issues first.
  - Issues that require an OpenSpec change before implementation — handle the spec/proposal step first.
  - Issues without testable acceptance criteria — sharpen the issue first.

**Flag, don't refuse**, when the work involves many sequential steps without a forcing function. Codex can lose track of intent across very long chains. Instrument the prompt with checkpoints ("after each subsection, restate the remaining acceptance criteria"). Don't downshift reasoning effort — keep `xhigh` (the default). The fix is sharper scope and explicit checkpoints, not lower budget.

## Workflow

### Step 0 — Detect the repo

Run these in the directory the user invoked the skill from. Capture into shell variables you use later — do **not** hard-code paths.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_NWO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"   # e.g. UseJunior/junior-AI-email-bot
DEFAULT_BRANCH="$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)"   # usually main
REPO_NAME="${REPO_NWO##*/}"
```

**Do not pre-enumerate build commands.** Codex will read `CLAUDE.md` / `AGENTS.md` and detect tooling itself. Your job is to point it at the right files and acceptance criteria, not to spell out `npm install` vs `uv sync`.

Before delegating, read:

- `CLAUDE.md` (root) — agent instructions
- `AGENTS.md` (root) — same, alternate filename
- `openspec/AGENTS.md` if it exists — proposal/spec workflow that may apply to this issue
- The issue itself (next step)

If `CLAUDE.md` / `AGENTS.md` mention OpenSpec or a spec workflow, **check whether the issue should go through that workflow first** before writing code. If it should, stop and report back to the user — do not delegate to Codex yet.

### Step 1 — Read the issue + plan the work

```bash
ISSUE=<the number>
gh issue view $ISSUE --repo "$REPO_NWO" --comments > "/tmp/issue-${ISSUE}.md"
cat "/tmp/issue-${ISSUE}.md"
```

Read the body and any comments. Identify:

- **Files most likely to need editing** — point Codex at them directly. Don't make it hunt.
- **Files to read for context** — `CLAUDE.md`, `AGENTS.md`, related layout/data/spec files.
- **Acceptance criteria** — what does "done" look like, concretely?
- **Out-of-scope sister issues** — list them so Codex doesn't stray.
- **Spec/OpenSpec gate** — if the issue calls for an OpenSpec change first, stop and surface that.
- **Labels** — `epic` means the scope is too broad for this skill; stop and report.

If the issue body has data tables / quotes / sample inputs, **inline them in your prompt** verbatim. Do **not** use `$(gh issue view ...)` inside a single-quoted heredoc — it does NOT expand and Codex gets the placeholder literally. Either:

- Pre-extract with `gh issue view $ISSUE > /tmp/issue-$ISSUE.md` (you already did this above) and reference the file path, or
- Use an unquoted heredoc and accept the shell-expansion, or
- Just paste the issue body inline in the prompt template below.

### Step 2 — Create the worktree yourself (do not delegate to Codex)

Codex's `workspace-write` sandbox blocks writes to the parent repo's `.git/` refs, so `git worktree add` invoked from inside Codex silently produces a plain directory with no `.git` linkage instead of a real worktree. You won't notice until commit time, when you discover there's no upstream to push and have to hand-copy the changed files into a freshly-created proper worktree (15+ minutes wasted). Create the worktree yourself before launching Codex:

```bash
BRANCH="fix/issue-${ISSUE}"
WT="${REPO_ROOT}/.worktrees/${BRANCH##*/}"
git -C "$REPO_ROOT" fetch origin "$DEFAULT_BRANCH"
git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WT" "origin/${DEFAULT_BRANCH}"
```

If the branch name collides with an existing worktree, append a short suffix (`fix/issue-${ISSUE}-v2`).

Pass `$REPO_NWO`, `$DEFAULT_BRANCH`, `$ISSUE`, `$BRANCH`, `$WT`, and the resolved repo root into the prompt so Codex has the orientation values without re-deriving them. Codex installs deps and runs verification inside `$WT` — it just doesn't create the worktree itself.

### Step 3 — Write the implementation prompt

Use this template. **Inline the issue body** instead of using shell substitution. Keep it tight — Codex over-explores when scope is genuinely ambiguous (not when it's complex; complexity is fine). Adapt every `<...>` placeholder to the actual repo.

````markdown
You are implementing GitHub issue #<ISSUE> in the `<REPO_NWO>` repo.

# Setup

Work in the existing git worktree at `<WT>` (the supervisor already created it from `origin/<DEFAULT_BRANCH>`). Install dependencies inside it. Do **not** create a new worktree — your `workspace-write` sandbox blocks writes to the parent repo's `.git/` refs and `git worktree add` silently produces a plain directory instead. Stay in `<WT>` for all edits.

# Repo orientation (READ FIRST)

- Read `CLAUDE.md` and/or `AGENTS.md` at the repo root before any edits.
- <one-sentence project summary — language, framework, what it does. Pull from CLAUDE.md/AGENTS.md.>
- <repo-specific conventions that matter for this issue. Examples to consider:
  - Test layout (e.g. `tests/` with pytest, or `*.test.ts` colocated)
  - Spec workflow (e.g. OpenSpec changes live in `openspec/changes/<id>/`)
  - Security/CSP/auth conventions if touching frontend or routes
  - Logging / telemetry conventions
  - Lint/format expectations (ruff, eslint, etc.)
  - Audience or product-tone conventions if writing user-facing copy>

# The issue (verbatim)

<PASTE the gh issue view output here, body + relevant comments. Do NOT use $(...) substitution inside a single-quoted heredoc.>

# Files to read first (don't go broader)

<list 2-5 specific files. Be concrete. Examples:
- workflows/research_pipeline/processors/research_executor.py
- src/_data/site.js
- crates/server/src/handlers/auth.rs>

# Concrete task

<state the goal in 1-3 sentences with target rendered output / API behavior / spec change if possible>

# Verification (run before stopping)

```bash
<repo-specific build command>     # e.g. uv sync, npm run build, cargo build
<repo-specific test command>      # e.g. uv run pytest tests/path/, npm test, cargo test
<specific grep/diff/curl commands to confirm the change works on 2-3 representative cases>
```

# Constraints

- **Do not commit or push.** Leave changes uncommitted; the parent supervisor reviews.
- **Don't touch unrelated files.** If you're tempted, stop and report.
- **Stay in `<WT>`.** Don't read or edit anything outside it. Do not create or move worktrees.
- **Honor repo conventions** — lint/format rules, security boundaries (e.g. CSP, SQL parameterization, trust-boundary checks), and any explicit "don't do X" rules in `CLAUDE.md` / `AGENTS.md`.
- **If the diff drifts outside the issue's acceptance criteria** (introducing unrelated files or capabilities), stop and report — that's a sign the scope drifted, not that you should rip more out.

# When done

Print:
1. Files changed (paths only)
2. Target verification output (the commands you ran above + their key output)
3. Anything you noticed but didn't fix (out of scope, or surprising)

Then stop.
````

Save this prompt to `/tmp/impl-${ISSUE}-$(date +%s).md`.

### Step 4 — Launch Codex headless in background

```bash
PROMPT_FILE=/tmp/impl-${ISSUE}-<timestamp>.md
LOG=/tmp/codex-impl-${ISSUE}.log

codex exec --sandbox workspace-write -C "$WT" "$(cat "$PROMPT_FILE")" < /dev/null > "$LOG" 2>&1
```

> **`< /dev/null` is mandatory, not decorative.** `codex exec` reads stdin for additional input by default. In a background run there's no TTY and no EOF on stdin unless you redirect one in — without `< /dev/null` the process blocks waiting for input that will never come, and it hangs indefinitely. This is the same failure mode `--full-auto` had (which is why that flag is deprecated here); redirecting stdin from `/dev/null` is what actually fixes it, so keep the redirect on every `codex exec` call below even if you also drop `--full-auto`.

Use `run_in_background: true` with a 15-minute timeout. **Do not poll** — the harness will notify you when the Bash tool's backgrounded process exits. No `&` and no `wait`/`pgrep` watcher are needed; `run_in_background` does both.

**Pitfall — the pgrep self-match deadlock.** Do not write a "wait" watcher like:

```bash
# ❌ BROKEN — hangs forever
until ! pgrep -f "codex exec.*${ISSUE}" > /dev/null; do sleep 30; done
```

`pgrep -f` matches against the full command line of every process — including the zsh shell that's running this very `until` loop, whose command line contains the literal string `codex exec.*${ISSUE}`. The watcher matches itself and never exits, even after Codex finishes. Symptom: you get told "still running" indefinitely, kill the watcher, and discover Codex actually finished hours ago.

If for some reason you genuinely need a watcher (you shouldn't — use `run_in_background`), use the character-class trick to avoid the self-match: `pgrep -f "[c]odex exec.*${ISSUE}"`. The regex `[c]odex` matches the literal string `codex` in the real Codex process but does NOT match `[c]odex` in the watcher's own command line.

**Always use Codex's default `xhigh` reasoning** for both implementation and peer-review calls. Don't downshift to `medium` even for "small" tasks. If Codex stalls, the right fix is a sharper prompt (clearer acceptance criteria, explicit checkpoints in long chains), not a lower reasoning budget.

### Step 5 — Validate Codex's output

When Codex returns:

```bash
tail -100 "$LOG"           # read summary
cd "$WT"                   # the worktree you created in Step 2
git status --short         # what changed?
git diff --stat            # how big?
git diff                   # actual diff for review
```

**Codex sometimes exits cleanly without making changes** (it concluded the task was already done, or hit a real blocker, or got stuck on prompt ambiguity). If `git diff` is empty:

- Check the log — did Codex hit a blocker? Did it report ambiguity? Did it conclude the task was already done?
- **Don't blindly retry.** Either sharpen the prompt and try again, finish the work yourself, or close the issue if Codex's reasoning is right.

**Scope-quality check** (not a line-count check): if the diff drifts outside the issue's acceptance criteria — introduces unrelated files, new capabilities not asked for, or refactors of code that wasn't supposed to change — stop and either re-prompt with tighter scope or take over. Raw size of the diff is not a red flag on its own; **drift from the issue is**.

### Step 6 — Run build + tests in the worktree

```bash
cd "$WT"
<build cmd>
<test cmd>
<lint cmd if the project enforces it (ruff, eslint, etc.)>
```

Use the commands Codex itself ran in its verification block — they're in the log.

If the build fails on something this PR introduced, fix it (or hand back to Codex with the error). If failures are pre-existing on `origin/<DEFAULT_BRANCH>`, document that in the PR body — don't try to fix them in this PR.

### Step 7 — Open the PR (without arming auto-merge)

Open the PR FIRST. Peer-review gates the merge in Step 8 — do NOT enable `--auto --squash` here.

```bash
cd "$WT"
git add <specific files — never `git add -A`>
git commit -m "$(cat <<'EOF'
<conventional commit subject>

<body explaining: why, what changed, how verified>

Peer review (agy + Codex) pending — see Step 8.

Closes #<ISSUE>.
EOF
)"
git push -u origin "$BRANCH"

gh pr create --repo "$REPO_NWO" --base "$DEFAULT_BRANCH" --head "$BRANCH" \
  --title "<title (closes #${ISSUE})>" \
  --body "$(cat <<'EOF'
## Summary
<2-3 lines on what + why>

## Implementation
<concise description of the actual change>

## Verification
- [x] Build clean (locally)
- [x] Test suite (note any pre-existing failures)
- [ ] Peer review (agy + Codex) — pending; will be appended below

## Closes
- #<ISSUE>
EOF
)"
# Capture the PR number/URL from the create output for the next step.
PR_NUMBER=<from gh output>
```

**Do not arm `gh pr merge --auto --squash` yet.** Auto-merge fires the moment CI passes; peer-review hasn't run.

### Step 8 — MANDATORY peer-review gate on the open PR

**Required by the user — no exceptions.** Run `/peer-review --agy --codex` against the diff that's now visible on the open PR. This gives reviewers the same surface area human reviewers would see (CI checks, deploy-preview comments if any, file tree).

The review must be **dynamic** — the reviewer actually opens the cited files and runs the cited build/test commands, not just reasons statically from the diff text. Include the reviewer-discipline block from the `peer-review` skill (open every affected file, verify claimed line numbers/signatures, actually run tests and paste output, no "logical simulation" language) in both prompts below.

```bash
REVIEW_FILE="/tmp/peer-review-${ISSUE}-$(date +%s).md"
cat > "$REVIEW_FILE" << EOF
## Review Request: <one-line summary>

### Repository
\`${WT}\` (worktree of ${REPO_NWO}, branched from origin/${DEFAULT_BRANCH})

### PR
${REPO_NWO}#${PR_NUMBER}

### Affected Files
\`\`\`
$(gh pr diff $PR_NUMBER --repo "$REPO_NWO" --name-only)
\`\`\`

### Diff
\`\`\`diff
$(gh pr diff $PR_NUMBER --repo "$REPO_NWO")
\`\`\`

### Major Assumptions
<list the load-bearing assumptions from your prompt to Codex>

### Areas of Uncertainty
<call out specific things you want both reviewers to focus on — e.g. trust boundaries, concurrency, API contract changes, security>

### Request
Please review critically — dynamically, by actually opening files and running commands, not by reasoning from the diff alone. Return a feedback prompt I can act on. Focus on what could break in production, not style nits.
EOF

# Launch both in parallel using two Bash tool calls in the SAME message,
# each with run_in_background: true. No `&`, no watcher loop — see the
# pgrep self-match pitfall in Step 4. Both calls redirect stdin from
# /dev/null for the same reason: no TTY in a background run means an
# un-redirected process hangs forever waiting for input.
codex exec --sandbox read-only -C "$WT" "$(cat "$REVIEW_FILE")" < /dev/null > /tmp/codex-review-${ISSUE}.log 2>&1
agy --print "$(cat "$REVIEW_FILE")" --add-dir "$WT" --dangerously-skip-permissions --print-timeout 10m > /tmp/agy-review-${ISSUE}.log 2>&1
```

`--sandbox read-only` is deliberate for the Codex review pass — the reviewer should read and run tests, not mutate the worktree while the implementation Codex run (or you) might still be touching it. `agy` needs `--dangerously-skip-permissions` to actually execute its dynamic-review steps (file reads, `git`, build, tests) instead of blocking on the first permission prompt and silently degrading to a static, contentless review — that's the documented failure mode of running it without the flag. Because `agy` gets full tool access, re-check `git branch --show-current` and `git rev-parse HEAD` in `$WT` after it returns; an autonomous reviewer can `git checkout`/reset your tree.

Wait for the harness completion notifications for both. Read the findings.

**Decision tree:**

- **Both reviewers concur the diff is good** → proceed to merge (Step 9).
- **Either reviewer flags a real bug or convention violation** → push a fix commit to the PR branch, then re-run peer-review. Do not skip the re-review.
- **Reviewers disagree** → use your judgment; document the trade-off as a PR comment.
- **Reviewers flag scope creep** → trim, push the fix, re-review.
- **Either reviewer returns a NEEDS-EXECUTION marker or leans on "logical simulation" / "mental trace" language instead of pasted command output** → treat it as no review, not as approval. Re-run with correct flags (most often `--dangerously-skip-permissions` was dropped) or supply the command output yourself and ask for a re-verdict.

After review:

```bash
# Append the peer-review summary to the PR body (or post as a comment)
gh pr comment $PR_NUMBER --repo "$REPO_NWO" --body "$(cat <<EOF
## Peer review (agy + Codex) — $(date +%Y-%m-%d)

**Codex findings**: <one-paragraph summary>

**agy findings**: <one-paragraph summary>

**Resolution**: <what you fixed, what you accepted as-is and why>
EOF
)"
```

### Step 9 — Arm auto-merge after peer-review approves

Only now (after peer-review approval) arm auto-squash:

```bash
gh pr merge $PR_NUMBER --repo "$REPO_NWO" --auto --squash
```

The PR will merge once CI is green. If CI fails on something this PR introduced, fix and push; the auto-merge stays armed.

### Step 10 — Verify on production after merge (when applicable)

If the project deploys automatically on merge to the default branch (Vercel, Railway, Azure DevOps pipeline, etc.), wait for the deploy and confirm the change rendered/behaves correctly in the live environment.

If there is no auto-deploy, skip this step and just confirm CI is green.

### Step 11 — Cleanup

```bash
cd "$REPO_ROOT"
git worktree remove "$WT"
```

## Repo notes (email-agent-mcp)

- **OpenSpec gate is scope-dependent.** Per `openspec/AGENTS.md`: bug fixes (restoring intended behavior), typos/formatting, non-breaking dependency bumps, config changes, and tests for existing behavior need **no** OpenSpec proposal. New features, breaking API/schema changes, architecture shifts, and behavior-changing performance/security work **do** — stop and surface the proposal step before delegating to Codex if the issue is the latter.
- **Spec-coverage gate.** Run `npm run check:spec-coverage` in Step 6 alongside build/test/lint — it's this repo's check that OpenSpec deltas and code stay in sync, and CI will fail without it.
- **Provider-touching changes need a live smoke, not just mocks.** If the diff touches Graph/provider code (anything under the email actions layer that calls out to Microsoft Graph), a green mocked test suite is not sufficient evidence — mocks miss Graph's server-side validation. After merge (Step 10), run a live smoke against a real mailbox before considering the change verified.

## Lessons captured

These cost real time on past runs. Don't repeat them.

1. **`$(gh issue view ...)` does NOT expand inside single-quoted heredocs.** Codex got the literal placeholder text. Either pre-extract to a file or use unquoted heredocs.
2. **Codex sometimes exits without making changes when the prompt is ambiguous, not when the work is complex.** It identifies the right files but stops before writing because the acceptance criterion isn't crisp. Mitigation: point Codex at specific files explicitly in the "Files to read first" section; give it a target output to verify against; do NOT downshift reasoning effort — keep `xhigh` (the default). The right fix is tighter intent, not lower budget.
3. **Codex's exit code is 0 even when it produced no work product.** Don't assume "exit 0 = task done" — always verify with `git diff`.
4. **Codex will read unrelated files** if the prompt mentions a broad area. Tight intent → better outcome.
5. **The mandatory peer-review step catches things both you and Codex miss.** It is not optional.
6. **Pre-commit hooks may fail on upstream-template flakes** unrelated to your change. Handle them in the worktree (don't `--no-verify`); fix the root cause if it's in scope.
7. **`epic`-labelled or OpenSpec-required issues are not eligible for this skill.** Surface them to the user and stop — they need a spec/proposal step first.
8. **Codex's `workspace-write` sandbox blocks `git worktree add`.** The call silently produces a plain directory (no `.git` linkage) instead of a real worktree, and you only notice at commit time when there's no upstream to push. Mitigation: the supervisor creates the worktree in Step 2 before launching Codex; Codex just works inside it. Never delegate worktree creation to Codex under a sandboxed `codex exec`.
9. **`codex exec --full-auto` is deprecated and unsafe in background runs.** Its code path (like any `codex exec` invoked without a stdin redirect) blocks on stdin and hangs forever with no TTY attached — you get no error, no timeout, just a run that never completes and never notifies you. Use `codex exec --sandbox workspace-write` (or `--sandbox read-only` for reviews) `-C "$WT" "<prompt>" < /dev/null` everywhere in this skill.
10. **Gemini CLI is not a peer-review option on this machine.** `gemini` may be aliased to an unrelated tool (observed: Anti-Gravity's `agy` CLI under the `gemini` name, which errors on old Gemini flags like `gemini --version` → `add_dirs[@]: unbound variable`). Use `agy --print "<prompt>" --add-dir <worktree> --dangerously-skip-permissions --print-timeout 10m` for the second reviewer instead — see Step 8.

## What this skill is NOT for

- Strategic / product / positioning work — judgment-heavy; the user does it themselves.
- Multi-PR refactors — this skill is one-issue-one-PR.
- `epic`-scoped issues or anything that needs an OpenSpec change first.
