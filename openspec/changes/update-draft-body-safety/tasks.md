## 1. Provider-level reply detection

- [ ] 1.1 Add a reply-draft determination on the Microsoft provider sourced from Graph metadata, not from body content
- [ ] 1.2 Fail closed: when reply status cannot be determined, treat the draft as a reply
- [ ] 1.3 Unit tests covering reply draft, fresh draft, and indeterminate cases

## 2. Body-edit safety in update_draft

- [ ] 2.1 Reject `body`/`body_file` on a reply draft with a recoverable structured error naming the remedy (create a new draft)
- [ ] 2.2 Accept `body` on a non-reply draft only when `replace_body: true` is passed; wholesale replace
- [ ] 2.3 Remove the `<hr>` / `divRplyFwdMsg` boundary-splice path
- [ ] 2.4 Regression test: a draft whose body contains a markdown `---` no longer accumulates stacked copies
- [ ] 2.5 Regression test: a reply draft with a Gmail-prefixed or Outlook-mobile boundary does not lose quoted history

## 3. Warnings channel

- [ ] 3.1 Add non-blocking `warnings` to draft-write responses
- [ ] 3.2 Emit a threading warning when `subject` is changed on a reply draft; do not block the change
- [ ] 3.3 Test that `subject`, `attachments`, `to`, `cc` remain editable on reply drafts

## 4. Surface and docs

- [ ] 4.1 Update the MCP `update_draft` tool schema and description for `replace_body`
- [ ] 4.2 Update any repo guidance that tells callers to create a new draft for every body edit
