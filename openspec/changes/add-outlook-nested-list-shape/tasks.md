## 1. Specification

- [x] Write the proposal and the `email-write` spec delta
- [x] Run `openspec validate add-outlook-nested-list-shape --strict`

## 2. Rendering

- [x] Split top-level ordered-list items whose single nested list is followed only by paragraphs; move the paragraphs out at the sub-paragraph margin and reopen the list with the running `start`
- [x] Apply the same split to top-level bullet lists; leave all other bullet lists on marked's path
- [x] Keep every `add-outlook-list-style` case unchanged except items with paragraphs after a nested list

## 3. Warning

- [x] Detect content after a nested list inside an `<li>` in rendered HTML with `node-html-parser`
- [x] Return `OUTLOOK_NESTED_LIST_REORDER` from `send_email`, `create_draft`, `update_draft`, `reply_to_email`; add `warnings` to the send/reply output schemas
- [x] Document in both READMEs and the `list_style` schema description

## 4. Verification

- [x] Renderer tests: issue repro shape and order, indentation parity, bullet parents, items that stay whole, default golden
- [x] Detector and action tests: repro HTML warns and is stored unchanged, every action returns the warning, no warning for nested lists that end their item
- [x] `npm run build`, `npm run lint`, `npm run test:run`, `npm run check:spec-coverage`
- [ ] Live Outlook draft smoke after merge
