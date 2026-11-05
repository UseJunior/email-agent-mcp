// Detect HTML that Outlook's compose editor reorders (issue #227).
//
// When a message is opened for editing, Outlook's editor hoists any content
// that follows a nested `<ul>`/`<ol>` inside the same `<li>` to *above* that
// nested list, and saves it in that order. Graph stores and returns the HTML
// as sent, so nothing server-side reveals the problem until a recipient (or
// the sender, editing a draft) opens it in Outlook.
//
// Caller-supplied HTML (`format: "html"`) is never rewritten; this check lets
// the compose actions return a warning instead. It runs on a real HTML parser
// (node-html-parser, already in the tree through node-html-markdown) so
// implicit `</li>` closes, wrapper `<div>`s, and attribute-laden tags are read
// the way a browser would read them, not by regex.

import { parse, NodeType } from 'node-html-parser';
import type { HTMLElement, Node } from 'node-html-parser';

/** Elements that carry content even with no text inside them. */
const CONTENT_ELEMENTS = new Set(['img', 'hr', 'table', 'iframe', 'video', 'audio', 'object', 'embed', 'svg', 'input']);
/** Elements whose text is never displayed. */
const HIDDEN_ELEMENTS = new Set(['script', 'style', 'template', 'head', 'title', 'noscript']);
const LIST_TAGS = new Set(['ul', 'ol']);
/** Elements whose boundaries separate words in the snippet; inline ones do not. */
const INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'span', 'font', 'code', 'sub', 'sup', 'small', 'mark']);

const SNIPPET_LENGTH = 60;

function tagOf(node: Node): string {
  return node.nodeType === NodeType.ELEMENT_NODE ? (node as HTMLElement).rawTagName?.toLowerCase() ?? '' : '';
}

/** Non-breaking spaces count as blank: they are what editors leave behind in empty lines. */
function isBlank(text: string): boolean {
  return text.replace(/[\s\u00a0]+/g, '') === '';
}

// Every walk below is iterative with an explicit stack: email HTML can nest
// thousands of wrappers deep, and a recursive walk (including the parser's own
// querySelectorAll) overflows the call stack on such input.

/**
 * Visit `root`'s descendants in document order (pre-order), not descending
 * into elements for which `enter` returns false. Stops when `visit` returns
 * true, and returns whether it did.
 */
function walk(root: Node, visit: (node: Node) => boolean, enter: (el: Node) => boolean = () => true): boolean {
  const stack: Node[] = [...root.childNodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visit(node)) return true;
    if (node.nodeType === NodeType.ELEMENT_NODE && enter(node)) {
      for (let k = node.childNodes.length - 1; k >= 0; k--) stack.push(node.childNodes[k]!);
    }
  }
  return false;
}

/** True for a node a reader would see: visible text, an image, a rule, a table. */
function isVisibleLeaf(node: Node): boolean {
  if (node.nodeType === NodeType.TEXT_NODE) return !isBlank(node.text);
  return CONTENT_ELEMENTS.has(tagOf(node));
}

/** True when `node` itself or anything inside it is visible. Hidden elements never are. */
function hasVisibleContent(node: Node): boolean {
  if (HIDDEN_ELEMENTS.has(tagOf(node))) return false;
  if (isVisibleLeaf(node)) return true;
  return walk(node, isVisibleLeaf, el => !HIDDEN_ELEMENTS.has(tagOf(el)));
}

/** The nearest `<li>` that contains `node`, or null. */
function enclosingItem(node: Node): HTMLElement | null {
  let current = node.parentNode;
  while (current) {
    if (tagOf(current) === 'li') return current;
    current = current.parentNode;
  }
  return null;
}

/**
 * True when something visible follows `list` inside `item` — a later sibling
 * of the list, or of any wrapper between the list and the `<li>`.
 */
function contentFollows(list: HTMLElement, item: HTMLElement): boolean {
  let node: Node = list;
  while (node !== item) {
    const parent: HTMLElement | null = node.parentNode;
    if (!parent) return false;
    const siblings = parent.childNodes;
    for (let k = siblings.indexOf(node) + 1; k < siblings.length; k++) {
      if (hasVisibleContent(siblings[k]!)) return true;
    }
    node = parent;
  }
  return false;
}

/** The item's own text before its first nested list, collapsed and shortened. */
function itemSnippet(item: HTMLElement): string {
  let text = '';
  walk(
    item,
    node => {
      if (LIST_TAGS.has(tagOf(node))) return true;
      if (node.nodeType === NodeType.TEXT_NODE) text += node.text;
      else if (node.nodeType === NodeType.ELEMENT_NODE && !INLINE_TAGS.has(tagOf(node))) text += ' ';
      return text.length > SNIPPET_LENGTH * 4;
    },
    el => !HIDDEN_ELEMENTS.has(tagOf(el)),
  );
  const collapsed = text.replace(/[\s\u00a0]+/g, ' ').trim();
  return collapsed.length > SNIPPET_LENGTH ? `${collapsed.slice(0, SNIPPET_LENGTH - 1)}…` : collapsed;
}

/**
 * The list items in `html` that hold a nested list followed by more content
 * inside the same `<li>` — the shape Outlook's editor reorders. Returns one
 * short snippet of each such item's lead-in text, in document order. A nested
 * list that is the last visible thing in its item is not a hazard, and neither
 * is Outlook's own shape (a `<ul>` directly inside an `<ol>`, outside any `<li>`).
 */
export function findNestedListReorderHazards(html: string): string[] {
  // Cheap pre-check: no list markup, nothing to parse.
  if (!/<(?:ul|ol)[\s>/]/i.test(html) || !/<li[\s>/]/i.test(html)) return [];

  const root = parse(html, { comment: false });
  const lists: HTMLElement[] = [];
  walk(root, node => {
    if (LIST_TAGS.has(tagOf(node))) lists.push(node as HTMLElement);
    return false;
  }, el => !HIDDEN_ELEMENTS.has(tagOf(el)));

  const hazards: string[] = [];
  const flagged = new Set<HTMLElement>();
  for (const list of lists) {
    const item = enclosingItem(list);
    if (!item || flagged.has(item)) continue;
    if (contentFollows(list, item)) {
      flagged.add(item);
      hazards.push(itemSnippet(item));
    }
  }
  return hazards;
}
