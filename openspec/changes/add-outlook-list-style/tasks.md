## 1. Specification

- [x] Write the proposal and the `email-write` spec delta for `list_style`
- [x] Run `openspec validate add-outlook-list-style --strict`

## 2. Rendering

- [x] Add `ListStyle` / `LIST_STYLES` and `RenderOptions.listStyle` to `body-renderer.ts`; leave the default branch as the existing `marked.parse` call
- [x] Implement the token-tree transform in `content/outlook-lists.ts`: chain top-level ordered lists across bridging paragraphs whose numbering continues, split items whose content is only paragraphs, render segments with explicit `start` via marked's own renderers
- [x] Keep bullet lists, items with nested lists or other blocks, and lists with nothing to reshape on marked's own path

## 3. Plumbing

- [x] Add a shared `ListStyleSchema` in `compose-helpers.ts` and `list_style` to `send_email`, `create_draft`, `update_draft`, `reply_to_email`
- [x] Merge `list_style` from body-file frontmatter in `resolveComposeFields`
- [x] Mention `list_style` in the `create_draft` tool description and both READMEs

## 4. Verification

- [x] Renderer tests: repro split shape, unindented parity, custom start, unchanged lists, nested lists, closing prose / restarted lists, default golden string, html/text ignored
- [x] Action tests: each compose action threads `list_style`; frontmatter override
- [x] `npm run build`, `npm run lint`, `npm run test:run`, `npm run check:spec-coverage`
- [ ] Live Outlook draft smoke after merge
