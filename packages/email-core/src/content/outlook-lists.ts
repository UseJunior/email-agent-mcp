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
//
// Content after a nested list (issue #227). Outlook's compose editor also
// hoists any block that follows a nested list inside an `<li>` to *above* that
// nested list when the message is opened, and saves it in that order. GFM
// produces exactly that shape for an item whose nested list is followed by a
// continuation paragraph. Outlook's own surviving shape keeps the lead-in and
// the nested list in the list and moves the follow-on paragraph out of it, so
// such an item is reshaped the same way as a continuation paragraph: the list
// closes after the item (which ends with its nested list), the follow-on
// paragraphs come next at the sub-paragraph margin, and the list reopens.
// Because the hoisting is a property of `<li>`, not of numbering, this also
// applies to top-level bullet lists — a bullet list is split only for this
// case; its plain continuation paragraphs stay inside the `<li>` as before.

import { marked, Parser } from 'marked';
import type { MarkedOptions, Token, Tokens } from 'marked';

/** Inline style Outlook itself writes on a first-level sub-paragraph. */
export const OUTLOOK_SUBPARAGRAPH_STYLE = 'margin-left:80px';

type OrderedList = Tokens.List & { ordered: true; start: number };
type BulletList = Tokens.List & { ordered: false };
type BlockText = Tokens.Paragraph | Tokens.Text;

function isOrderedList(token: Token | undefined): token is OrderedList {
  return token?.type === 'list'
    && (token as Tokens.List).ordered
    && typeof (token as Tokens.List).start === 'number';
}

function isBulletList(token: Token | undefined): token is BulletList {
  return token?.type === 'list' && !(token as Tokens.List).ordered;
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

/** An item split after its nested list: what stays in the `<li>`, and what moves out. */
interface NestedListSplit {
  /** The item's tokens up to and including its nested list. */
  keep: Token[];
  /** The paragraphs that followed the nested list. */
  trailing: BlockText[];
}

/**
 * The split for an item Outlook would reorder (issue #227) — a plain
 * (non-task) item holding exactly one nested list, followed only by one or more
 * paragraphs. Whatever precedes the nested list stays in the `<li>` untouched.
 * Items with two nested lists, or with a code block, quote, table, or other
 * non-paragraph block after the nested list, stay whole: those cannot be moved
 * out as margin-indented paragraphs. The HTML hazard check still flags them.
 */
function nestedListSplit(item: Tokens.ListItem): NestedListSplit | null {
  if (item.task) return null;
  const lists = item.tokens.filter(t => t.type === 'list');
  if (lists.length !== 1) return null;
  const at = item.tokens.indexOf(lists[0]!);
  const after = item.tokens.slice(at + 1).filter(t => t.type !== 'space');
  if (after.length === 0 || !after.every(isBlockText)) return null;
  return { keep: item.tokens.slice(0, at + 1), trailing: after as BlockText[] };
}

/**
 * A copy of a plain-paragraph item rendered the way marked renders a loose list
 * item (`<li><p>…</p></li>`), so the indented and unindented markdown habits —
 * which marked lexes as loose and tight lists respectively — produce the same
 * HTML. This is the same text→paragraph promotion marked applies to loose
 * lists. Items holding anything but paragraphs (nested list, code, quote, ...)
 * and task items keep marked's own tokens and render exactly as by default.
 */
function asLooseItem(item: Tokens.ListItem, tokens: Token[]): Tokens.ListItem {
  if (item.task || !item.tokens.every(t => t.type === 'space' || isBlockText(t))) return item;
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

/** A paragraph moved out of a list, at Outlook's sub-paragraph margin. */
function indentedParagraph(paragraph: BlockText, parser: Parser): string {
  return `<p style="${OUTLOOK_SUBPARAGRAPH_STYLE}">${parser.parseInline(paragraph.tokens ?? [])}</p>\n`;
}

/**
 * A top-level bullet list with an item Outlook would reorder, rendered as
 * `<ul>` segments split after each such item, with that item's follow-on
 * paragraphs between the segments. Every item keeps marked's own markup; only
 * the reordered items lose their trailing paragraphs.
 */
function renderBulletList(list: BulletList, parser: Parser): string {
  let html = '';
  let items = '';
  const flush = (): void => {
    if (items === '') return;
    html += `<ul>\n${items}</ul>\n`;
    items = '';
  };
  for (const item of list.items) {
    const nested = nestedListSplit(item);
    if (!nested) {
      items += parser.renderer.listitem(item);
      continue;
    }
    items += parser.renderer.listitem({ ...item, tokens: nested.keep });
    flush();
    for (const paragraph of nested.trailing) html += indentedParagraph(paragraph, parser);
  }
  flush();
  return html;
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
    html += indentedParagraph(paragraph, parser);
  };

  chain.lists.forEach((list, i) => {
    for (const item of list.items) {
      const paragraphs = splittableParagraphs(item);
      const nested = paragraphs ? null : nestedListSplit(item);
      if (paragraphs) {
        pending.push(asLooseItem(item, [paragraphs[0]!]));
        flush();
        paragraphs.slice(1).forEach(indent);
      } else if (nested) {
        pending.push({ ...item, tokens: nested.keep });
        flush();
        nested.trailing.forEach(indent);
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
 * item carries continuation paragraphs, paragraphs follow an item's nested
 * list, or paragraphs sit between two parts of one numbered list. Top-level
 * bullet lists are split only where paragraphs follow an item's nested list.
 * Lists with nothing to reshape — and all other blocks — render exactly as
 * marked renders them.
 */
export function renderMarkdownOutlookLists(raw: string, options: MarkedOptions): string {
  // Fresh option object per call: Lexer and Parser attach their tokenizer and
  // renderer to the object they are given.
  const opts: MarkedOptions = { ...marked.defaults, ...options, async: false };
  const tokens = marked.lexer(raw, opts);
  const parser = new Parser(opts);

  const out: Token[] = [];
  let i = 0;
  const htmlToken = (html: string): Tokens.HTML =>
    ({ type: 'html', block: true, pre: false, raw: html, text: html }) as Tokens.HTML;

  while (i < tokens.length) {
    const token = tokens[i]!;
    if (isBulletList(token) && token.items.some(item => nestedListSplit(item) !== null)) {
      out.push(htmlToken(renderBulletList(token, parser)));
      i++;
      continue;
    }
    if (!isOrderedList(token)) {
      out.push(token);
      i++;
      continue;
    }
    const chain = collectChain(tokens, i);
    const reshape = chain.bridges.length > 0
      || chain.lists.some(list => list.items.some(item =>
        splittableParagraphs(item) !== null || nestedListSplit(item) !== null));
    if (!reshape) {
      out.push(token);
      i++;
      continue;
    }
    out.push(htmlToken(renderChain(chain, parser)));
    i = chain.next;
  }

  return parser.parse(out);
}
