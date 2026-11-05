// Markdown → HTML rendering for outgoing email bodies.
// Centralizes the "agents write markdown, providers ship HTML" contract so
// actions don't have to think about format and providers stay dumb.
//
// Ref: `~/Projects/foam-notes/scripts/save_draft_to_outlook.py` uses the same
// approach (python-markdown with `nl2br`+`extra`, force-black wrapper).

import { marked } from 'marked';
import { renderMarkdownOutlookLists } from './outlook-lists.js';

export type BodyFormat = 'markdown' | 'html' | 'text';

export const BODY_FORMATS: readonly BodyFormat[] = ['markdown', 'html', 'text'];

/**
 * How ordered lists in a markdown body are shaped.
 *
 * - `default`: standard markdown rendering.
 * - `outlook`: ordered-list items with continuation paragraphs (and paragraphs
 *   sitting between two parts of one numbered list) are emitted in the split
 *   shape Outlook's own editor saves — `<ol start="N">` segments with the
 *   sub-paragraphs outside the list as `<p style="margin-left:80px">` — so a
 *   recipient editing in Outlook can indent a sub-paragraph without the list
 *   renumbering (issue #228).
 */
export type ListStyle = 'default' | 'outlook';

export const LIST_STYLES: readonly ListStyle[] = ['default', 'outlook'];

export interface RenderOptions {
  /** Default 'markdown'. */
  format?: BodyFormat;
  /**
   * Wrap rendered HTML in `<div style="color:#000000">` so Outlook dark mode
   * doesn't invert body text to unreadable white-on-white. Default true.
   * Ignored when format is 'text'.
   */
  forceBlack?: boolean;
  /**
   * Ordered-list shaping for markdown bodies. Default 'default'. Ignored when
   * format is 'html' (passthrough) or 'text' (no rendering).
   */
  listStyle?: ListStyle;
}

export interface RenderedBody {
  /**
   * Plain-text / source content. Always populated — holds the raw input as
   * a plain-text fallback for clients that can't render HTML.
   */
  body: string;
  /**
   * Rendered HTML. Populated for `markdown` and `html` formats; undefined
   * for `text`. Providers that see `bodyHtml` send with HTML content-type;
   * otherwise they fall back to `body` as plain text.
   */
  bodyHtml?: string;
}

/**
 * Render an email body for transport.
 *
 * - `markdown` (default): renders via `marked` with `breaks: true` (single `\n`
 *   becomes `<br>`) and `gfm: true` (tables, strikethrough, fenced code).
 *   Raw HTML inside markdown is preserved, so callers that already hand us
 *   HTML don't regress. The raw markdown is kept in `body` as a plain-text
 *   fallback.
 *   With `listStyle: 'outlook'`, ordered lists are reshaped into Outlook's
 *   split-list form (see `outlook-lists.ts`); without it the output is exactly
 *   `marked.parse`'s.
 * - `html`: passthrough; caller already rendered.
 * - `text`: no rendering; `bodyHtml` is undefined so providers send as plain.
 *
 * When HTML is produced, it is wrapped in a force-black div by default so
 * Outlook's dark mode doesn't make the text invisible.
 */
export function renderEmailBody(raw: string, opts: RenderOptions = {}): RenderedBody {
  const format: BodyFormat = opts.format ?? 'markdown';

  if (format === 'text') {
    return { body: raw };
  }

  let html: string;
  if (format === 'html') {
    html = raw;
  } else if (opts.listStyle === 'outlook') {
    html = renderMarkdownOutlookLists(raw, { breaks: true, gfm: true });
  } else {
    // marked.parse is sync when async:false is passed; cast for TS.
    html = marked.parse(raw, { breaks: true, gfm: true, async: false }) as string;
  }

  if (opts.forceBlack !== false) {
    html = `<div style="color: #000000;">${html}</div>`;
  }

  return { body: raw, bodyHtml: html };
}
