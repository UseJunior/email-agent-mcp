# Tasks: add markdown body rendering

## 1. Core renderer

- [x] 1.1 Add `marked ^18.0.0` to `@usejunior/email-core` dependencies
- [x] 1.2 Create `packages/email-core/src/content/body-renderer.ts` with `renderEmailBody(raw, opts)` returning `{ body, bodyHtml? }`
- [x] 1.3 Support `format: 'markdown' | 'html' | 'text'` (default markdown) and `forceBlack: boolean` (default true)
- [x] 1.4 Markdown path uses `marked.parse(raw, { breaks: true, gfm: true, async: false })`
- [x] 1.5 HTML path is passthrough; text path returns `{ body }` only, no HTML
- [x] 1.6 Force-black wrapper: `<div style="color: #000000;">…</div>` applied to HTML output unless disabled
- [x] 1.7 Unit tests in `body-renderer.test.ts` covering headings, bold, bullets, tables, `<br>` for single newlines, raw-HTML passthrough, force-black toggle, text format, html format

## 2. Frontmatter schema

- [x] 2.1 Add `format?: BodyFormat` and `force_black?: boolean` to `FrontmatterFields` in `frontmatter.ts`
- [x] 2.2 Parse both keys; `format` validates against `BODY_FORMATS` enum; unknown values silently ignored

## 3. Compose-helpers plumbing

- [x] 3.1 Extend `ComposeFields` with `format?: BodyFormat` and `forceBlack?: boolean`
- [x] 3.2 `resolveComposeFields` reads `format`/`force_black` from input; frontmatter overrides input

## 4. Action wiring

- [x] 4.1 `send_email`: add `format` + `force_black` to `SendEmailInput` Zod schema
- [x] 4.2 `send_email`: call `renderEmailBody` after field resolution; pass `bodyHtml` on both draft and send paths; truncate `body` and `bodyHtml` independently
- [x] 4.3 `create_draft`: add `format` + `force_black` to `CreateDraftInput`; render + pass `bodyHtml` on standard and reply-draft paths
- [x] 4.4 `update_draft`: add `format` + `force_black` to `UpdateDraftInput`; render + set `partial.bodyHtml` when body changes
- [x] 4.5 `reply_to_email`: add `format` + `force_black` to `ReplyToEmailInput`; render + pass `bodyHtml` via `ReplyOptions` on both send and draft paths

## 5. Provider updates

- [x] 5.1 `ReplyOptions` gains `bodyHtml?: string` in `types.ts`
- [x] 5.2 Graph provider: add `buildGraphBody(bodyHtml, body)` helper that picks HTML or Text contentType
- [x] 5.3 Graph provider: `sendMessage`, `replyToMessage`, `createDraft`, `createReplyDraft`, `updateDraft` all use `buildGraphBody` and honor `opts?.bodyHtml`
- [x] 5.4 Gmail provider: `buildRawMessage` picks `text/html` when `bodyHtml` set, `text/plain` otherwise
- [x] 5.5 Gmail provider: `replyToMessage` forwards `opts.bodyHtml` through to the reply `ComposeMessage`

## 6. Mock provider

- [x] 6.1 `mock-provider.ts` `replyToMessage` records `opts.bodyHtml` on the sent message
- [x] 6.2 `createReplyDraft` records `opts.bodyHtml` on the draft
- [x] 6.3 `updateDraft` applies `msg.bodyHtml` to the stored draft

## 7. Tests

- [x] 7.1 Unit: `body-renderer.test.ts` (12 cases)
- [x] 7.2 Integration: `send.test.ts` new "Body Rendering" describe block — markdown renders, `<br>` for newlines, `format: text`, `format: html`, `force_black: false`, frontmatter `format: text` override
- [x] 7.3 Integration: `draft.test.ts` new "Draft Body Rendering" describe block — `create_draft` and `update_draft` render markdown
- [x] 7.4 Integration: `reply.test.ts` new "Reply Body Rendering" describe block — send path, draft path, `format: text` override
- [x] 7.5 Provider: `email-graph-provider.test.ts` new "Body Content Type" — `bodyHtml` set → HTML contentType; only body set → Text contentType; `createDraft` honors `bodyHtml`; `replyToMessage` forwards `opts.bodyHtml`
- [x] 7.6 Provider: `email-gmail-provider.test.ts` new "Body Content Type" — `text/html` when `bodyHtml` set, `text/plain` otherwise, newlines preserved
- [x] 7.7 Update existing truncation test to assert both `body` and `bodyHtml` truncated

## 8. Verification

- [x] 8.1 `npm run build` — all 4 packages typecheck clean
- [x] 8.2 `npx vitest run` — all tests green (406 passing)
- [ ] 8.3 Manual live send (Outlook): markdown brief with headers / bold / bullets / table / line breaks — verify rendering in light + dark mode
- [ ] 8.4 Manual live send (Gmail): same markdown brief — verify rendering
- [ ] 8.5 Regression: `format: 'text'` send → plain text with preserved newlines; `format: 'html'` send with pre-rendered HTML → passthrough
- [ ] 8.6 OpenClaw path: trigger morning brief against worktree build → output matches foam-quality rendering
