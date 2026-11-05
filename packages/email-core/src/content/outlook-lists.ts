// Outlook-shaped ordered lists for markdown bodies (issue #228).
//
// A common email layout is numbered items, each followed by lettered
// sub-paragraphs. Standard markdown renders those sub-paragraphs as `<p>`
// inside the `<li>` (indented variant) or as flush-left `<p>` between separate
// `<ol>`s (unindented variant). Outlook on the web's editor does not keep block
// content inside `<li>`: pressing Tab on such a sub-paragraph indents the whole
// item, demoting the numbered heading above it and renumbering the list.
//
// When a user builds the same layout by hand, Outlook saves it *split*: the
// `<ol>` closes after the item, the sub-paragraphs follow outside the list as
// `<p style="margin-left:80px">`, and the list resumes with `<ol start="N">`.
// That shape renders the sub-paragraphs deeper than the numbers and survives
// editing, so this module emits it.
//
// Design: the transform runs on marked's token tree, not on rendered HTML.
// Top-level ordered-list tokens are grouped into "chains" (one list, or several
// lists separated only by paragraphs whose numbering continues), and each
// changed chain is rendered by marked's own renderer for list items and inline
// content. Everything else goes through marked's parser untouched, so an input
// with nothing to reshape renders byte-identically to the default mode.

import { marked, Parser } from 'marked';
import type { MarkedOptions, Token, Tokens } from 'marked';

/** Inline style Outlook itself writes on a first-level sub-paragraph. */
export const OUTLOOK_SUBPARAGRAPH_STYLE = 'margin-left:80px';

type OrderedList = Tokens.List & { ordered: true; start: number };
type BlockText = Tokens.Paragraph | Tokens.Text;

function isOrderedList(token: Token | undefined): token is OrderedList {
  return token?.type === 'list'
    && (token as Tokens.List).ordered
    && typeof (token as Tokens.List).start === 'number';
}

function isBlockText(token: Token): token is BlockText {
  return token.type === 'paragraph' || token.type === 'text';
}

/**
 * The item's paragraphs when it should be split — a plain (non-task) item
 * whose children are two or more paragraphs and nothing else. Items holding a
 * nested list, code block, quote, table, or any other block stay whole.
 */
function splittableParagraphs(item: Tokens.ListItem): BlockText[] | null {
  if (item.task) return null;
  const blocks = item.tokens.filter(t => t.type !== 'space');
  if (blocks.length < 2 || !blocks.every(isBlockText)) return null;
  return blocks as BlockText[];
}

/**
 * A copy of `item` rendered the way marked renders a loose list item
 * (`<li><p>…</p></li>`), so the indented and unindented markdown habits — which
 * marked lexes as loose and tight lists respectively — produce the same HTML.
 * This is the same text→paragraph promotion marked applies to loose lists.
 * Task items keep marked's own tokens, since their checkbox placement depends
 * on the original looseness.
 */
function asLooseItem(item: Tokens.ListItem, tokens: Token[]): Tokens.ListItem {
  if (item.task) return item;
  return {
    ...item,
    loose: true,
    tokens: tokens.map(t => (t.type === 'text' && 'tokens' in t && t.tokens
      ? { ...t, type: 'paragraph' } as Tokens.Paragraph
      : t)),
  };
}

interface Chain {
  lists: OrderedList[];
  /** `bridges[i]` holds the paragraphs between `lists[i]` and `lists[i + 1]`. */
  bridges: Tokens.Paragraph[][];
  /** Index of the first top-level token after the chain. */
  next: number;
}

/**
 * Starting at the ordered list `tokens[index]`, gather the lists that read as
 * one list interrupted by paragraphs: only paragraphs (and blank lines) between
 * them, and the later list's start number continuing the earlier one's count.
 * A later list that restarts its numbering is a new list and ends the chain,
 * as does any other block (heading, code, quote, bullet list, ...).
 */
function collectChain(tokens: Token[], index: number): Chain {
  const first = tokens[index] as OrderedList;
  const lists: OrderedList[] = [first];
  const bridges: Tokens.Paragraph[][] = [];
  let expected = first.start + first.items.length;
  let next = index + 1;

  for (;;) {
    const paragraphs: Tokens.Paragraph[] = [];
    let k = next;
    while (k < tokens.length && (tokens[k]!.type === 'space' || tokens[k]!.type === 'paragraph')) {
      if (tokens[k]!.type === 'paragraph') paragraphs.push(tokens[k] as Tokens.Paragraph);
      k++;
    }
    const candidate = tokens[k];
    if (paragraphs.length === 0 || !isOrderedList(candidate) || candidate.start !== expected) break;
    bridges.push(paragraphs);
    lists.push(candidate);
    expected = candidate.start + candidate.items.length;
    next = k + 1;
  }

  return { lists, bridges, next };
}

function renderChain(chain: Chain, parser: Parser): string {
  let html = '';
  let segmentStart = chain.lists[0]!.start;
  let pending: Tokens.ListItem[] = [];

  const flush = (): void => {
    if (pending.length === 0) return;
    // Same markup marked's renderer.list emits, except `start` is always
    // explicit — Outlook writes `<ol start="1">` on the first segment too.
    let items = '';
    for (const item of pending) items += parser.renderer.listitem(item);
    html += `<ol start="${segmentStart}">\n${items}</ol>\n`;
    segmentStart += pending.length;
    pending = [];
  };
  const indent = (paragraph: BlockText): void => {
    html += `<p style="${OUTLOOK_SUBPARAGRAPH_STYLE}">${parser.parseInline(paragraph.tokens ?? [])}</p>\n`;
  };

  chain.lists.forEach((list, i) => {
    for (const item of list.items) {
      const paragraphs = splittableParagraphs(item);
      if (paragraphs) {
        pending.push(asLooseItem(item, [paragraphs[0]!]));
        flush();
        paragraphs.slice(1).forEach(indent);
      } else {
        pending.push(asLooseItem(item, item.tokens));
      }
    }
    const bridge = chain.bridges[i];
    if (bridge) {
      flush();
      bridge.forEach(indent);
    }
  });
  flush();

  return html;
}

/**
 * Render markdown to HTML like `marked.parse(raw, options)`, but with
 * top-level ordered lists reshaped into Outlook's split-list form wherever an
 * item carries continuation paragraphs or paragraphs sit between two parts of
 * one numbered list. Lists with nothing to reshape — and all other blocks —
 * render exactly as marked renders them.
 */
export function renderMarkdownOutlookLists(raw: string, options: MarkedOptions): string {
  // Fresh option object per call: Lexer and Parser attach their tokenizer and
  // renderer to the object they are given.
  const opts: MarkedOptions = { ...marked.defaults, ...options, async: false };
  const tokens = marked.lexer(raw, opts);
  const parser = new Parser(opts);

  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (!isOrderedList(token)) {
      out.push(token);
      i++;
      continue;
    }
    const chain = collectChain(tokens, i);
    const reshape = chain.bridges.length > 0
      || chain.lists.some(list => list.items.some(item => splittableParagraphs(item) !== null));
    if (!reshape) {
      out.push(token);
      i++;
      continue;
    }
    const html = renderChain(chain, parser);
    out.push({ type: 'html', block: true, pre: false, raw: html, text: html } as Tokens.HTML);
    i = chain.next;
  }

  return parser.parse(out);
}
